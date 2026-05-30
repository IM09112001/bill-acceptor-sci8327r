import { EventEmitter } from 'node:events';
import { SerialPort } from 'serialport';

import config from '../config';
import { AppError, normalizeError } from '../errors';
import { buildOmnibus, parseDeviceResponse, type OmnibusOptions } from '../protocol';
import {
  ERROR_CODES,
  type DeviceEventPayload,
  type DeviceMode,
  type DeviceStatus,
  type ParsedDeviceResponse,
  type ErrorCode,
} from '../types';

const EBDS_STX = 0x02;

class BillAcceptor extends EventEmitter {

  private _port: SerialPort | null = null;
  private _connected: boolean = false;
  private _mode: DeviceMode = 'CLOSED';
  private _enabled: boolean = false;
  private _autoStack: boolean = false;
  private _billInEscrow: boolean = false;
  private _ackBit: 0 | 1 = 0; // toggled after each successful exchange
  private _busy: boolean = false;
  private _pollTimer: NodeJS.Timeout | null = null;
  private _lastRawResponse: string | null = null;

  emit(event: 'device-event', payload: DeviceEventPayload): boolean;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  emit(event: string, ...args: any[]): boolean {
    return super.emit(event, ...args);
  }

  on(event: 'device-event', listener: (payload: DeviceEventPayload) => void): this;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(event: string, listener: (...args: any[]) => void): this {
    return super.on(event, listener);
  }

  getStatus(): DeviceStatus {
    return {
      connected: this._connected,
      mode: this._mode,
      enabled: this._enabled,
      autoStack: this._autoStack,
      billInEscrow: this._billInEscrow,
      serialPort: config.serial.path,
      lastRawResponse: this._lastRawResponse,
    };
  }

  async open(): Promise<DeviceStatus> {
    if (this._connected) return this.getStatus();

    this._mode = 'OPENING';

    const port = new SerialPort({
      path: config.serial.path,
      baudRate: config.serial.baudRate,
      dataBits: config.serial.dataBits,
      stopBits: config.serial.stopBits,
      parity: config.serial.parity,
      autoOpen: false,
    });

    // attach the error handler up front so an open() failure doesn't go unhandled
    port.on('error', (err: Error) => {
      this.emit('device-event', {
        status: 'ERROR',
        code: ERROR_CODES.DEVICE_ERROR,
        message: err.message,
      });
    });

    port.on('close', () => {
      this._stopPolling();
      if (this._connected) {
        this._connected = false;
        this._mode = 'CLOSED';
        this._enabled = false;
        this._billInEscrow = false;
        this._ackBit = 0;
        this.emit('device-event', { status: 'DISCONNECTED' });
      }
    });

    await new Promise<void>((resolve, reject) => {
      port.open((err) => {
        if (err) {
          this._mode = 'CLOSED';
          reject(new AppError(this._classifyPortError(err), err.message));
        } else {
          resolve();
        }
      });
    });

    this._port = port;
    this._connected = true;
    this._mode = 'OPEN';
    this._ackBit = 0;

    try {
      await this._sendCommand({ enable: false, escrow: false });
    } catch (err) {
      this._connected = false;
      this._mode = 'CLOSED';
      this._port = null;
      port.close(() => {});
      throw err;
    }

    this.emit('device-event', { status: 'CONNECTED', ...this.getStatus() });
    this._startPolling();
    return this.getStatus();
  }

  async close(): Promise<DeviceStatus> {
    this._stopPolling();

    if (this._port && this._port.isOpen) {
      await new Promise<void>((resolve) => this._port!.close(() => resolve()));
    }

    this._connected = false;
    this._mode = 'CLOSED';
    this._enabled = false;
    this._billInEscrow = false;
    this._ackBit = 0;
    this._port = null;

    this.emit('device-event', { status: 'DISCONNECTED' });
    return this.getStatus();
  }

  // STATUS swallows its errors so it's safe to call in any state
  async status(): Promise<DeviceStatus & { deviceResponse?: ParsedDeviceResponse; error?: { code: ErrorCode; message: string } }> {
    if (!this._connected) return this.getStatus();
    try {
      const parsed = await this._sendCommand(this._pollOpts());
      return { ...this.getStatus(), deviceResponse: parsed };
    } catch (err: unknown) {
      const appErr = normalizeError(err);
      return { ...this.getStatus(), error: { code: appErr.code, message: appErr.message } };
    }
  }

  async capture(): Promise<DeviceStatus & { deviceResponse: ParsedDeviceResponse }> {
    this._ensureConnected();
    this._enabled = true;
    this._mode = 'CAPTURE';
    const parsed = await this._sendCommand(this._pollOpts());
    return { ...this.getStatus(), deviceResponse: parsed };
  }

  async enable(): Promise<DeviceStatus & { deviceResponse: ParsedDeviceResponse }> {
    this._ensureConnected();
    this._enabled = true;
    const parsed = await this._sendCommand(this._pollOpts());
    return { ...this.getStatus(), deviceResponse: parsed };
  }

  async disable(): Promise<DeviceStatus & { deviceResponse: ParsedDeviceResponse }> {
    this._ensureConnected();
    this._enabled = false;
    this._mode = 'DISABLED';
    const parsed = await this._sendCommand({ enable: false, escrow: false });
    return { ...this.getStatus(), deviceResponse: parsed };
  }

  async stack(): Promise<DeviceStatus & { deviceResponse: ParsedDeviceResponse }> {
    this._ensureConnected();
    if (!this._billInEscrow) {
      throw new AppError(ERROR_CODES.NO_ESCROW, 'Cannot stack: no bill in escrow');
    }
    // pulse the stack bit on a single poll; the device reports stacking/stacked on later polls
    const parsed = await this._sendCommand(this._pollOpts({ stack: true }));
    return { ...this.getStatus(), deviceResponse: parsed };
  }

  async returnBill(): Promise<DeviceStatus & { deviceResponse: ParsedDeviceResponse }> {
    this._ensureConnected();
    if (!this._billInEscrow) {
      throw new AppError(ERROR_CODES.NO_ESCROW, 'Cannot return: no bill in escrow');
    }
    const parsed = await this._sendCommand(this._pollOpts({ return: true }));
    return { ...this.getStatus(), deviceResponse: parsed };
  }

  async setAutoStack(enabled: boolean): Promise<DeviceStatus> {
    this._autoStack = Boolean(enabled);
    return this.getStatus();
  }

  private async _sendCommand(opts: OmnibusOptions): Promise<ParsedDeviceResponse> {
    this._ensureConnected();

    if (this._busy) {
      throw new AppError(ERROR_CODES.DEVICE_ERROR, 'Device is busy');
    }

    this._busy = true;
    try {
      const frame = buildOmnibus(opts, this._ackBit);
      const response = await this._writeAndRead(frame);
      const parsed = parseDeviceResponse(response);

      this._lastRawResponse = parsed.raw;
      this._ackBit = (this._ackBit ^ 1) as 0 | 1;

      this._applyResponse(parsed);

      if (parsed.error) {
        const code = (ERROR_CODES as Record<string, ErrorCode>)[parsed.error]
          ?? ERROR_CODES.DEVICE_ERROR;
        throw new AppError(code, `Device error: ${parsed.error}`);
      }

      return parsed;
    } finally {
      this._busy = false;
    }
  }

  // At 9600 baud the OS hands us the response in pieces, so we buffer until a
  // whole frame is in hand.
  private _writeAndRead(command: Buffer): Promise<Buffer> {
    return new Promise<Buffer>((resolve, reject) => {
      let timer: NodeJS.Timeout;
      let accumulated = Buffer.alloc(0);

      const cleanup = () => {
        clearTimeout(timer);
        this._port!.removeListener('data', onData);
        this._port!.removeListener('error', onError);
      };

      const onData = (chunk: Buffer) => {
        accumulated = Buffer.concat([accumulated, chunk]);

        if (accumulated.length < 2) return;

        // drop any junk ahead of the STX so we stay framed
        const stxIdx = accumulated.indexOf(EBDS_STX);
        if (stxIdx < 0) { accumulated = Buffer.alloc(0); return; }
        if (stxIdx > 0) accumulated = accumulated.subarray(stxIdx);
        if (accumulated.length < 2) return;

        const totalLen = accumulated[1]; // byte 1 is the full frame length

        if (accumulated.length >= totalLen) {
          cleanup();
          resolve(accumulated.subarray(0, totalLen));
        }
      };

      const onError = (err: Error) => {
        cleanup();
        reject(new AppError(ERROR_CODES.DEVICE_DISCONNECTED, err.message));
      };

      this._port!.on('data', onData);
      this._port!.on('error', onError);

      timer = setTimeout(() => {
        cleanup();
        reject(new AppError(ERROR_CODES.DEVICE_NOT_RESPONDING, 'Device did not respond in time'));
      }, config.serialTimeoutMs);
      this._port!.write(command, (err) => {
        if (err) {
          cleanup();
          reject(new AppError(ERROR_CODES.DEVICE_DISCONNECTED, err.message));
        }
      });
    });
  }

  private _applyResponse(parsed: ParsedDeviceResponse): void {
    if (parsed.error) {
      this._handleDeviceError(parsed.error);
    } else if (parsed.event) {
      this._handleDeviceEvent(parsed.event, parsed);
    }
  }

  private _handleDeviceError(errorCode: string): void {
    const codeMap: Record<string, ErrorCode> = {
      BILL_JAMMED: ERROR_CODES.BILL_JAMMED,
      CASSETTE_FULL: ERROR_CODES.CASSETTE_FULL,
      CASSETTE_REMOVED: ERROR_CODES.CASSETTE_REMOVED,
    };
    const code = codeMap[errorCode] ?? ERROR_CODES.DEVICE_ERROR;
    this._mode = 'ERROR';
    this.emit('device-event', { status: 'ERROR', code, message: errorCode });
  }

  private _handleDeviceEvent(event: string, parsed: ParsedDeviceResponse): void {
    const ds = parsed.deviceStatus;

    switch (event) {
      case 'ESCROW':
        this._billInEscrow = true;
        this._mode = 'ESCROW';
        this.emit('device-event', { status: 'ESCROW', docType: ds.docType });
        // We're still inside the poll's _sendCommand here (busy lock held), so
        // defer the stack until that exchange finishes and the lock is free.
        if (this._autoStack) {
          setImmediate(() => {
            if (this._autoStack && this._billInEscrow) this.stack().catch(() => {});
          });
        }
        break;

      case 'STACKING':
        this._mode = 'STACKING';
        this.emit('device-event', { status: 'STACKING' });
        break;

      case 'STACKED':
        this._billInEscrow = false;
        this._mode = 'CAPTURE';
        this.emit('device-event', { status: 'STACKED', docType: ds.docType });
        break;

      case 'RETURNING':
        this._mode = 'RETURNING';
        this.emit('device-event', { status: 'RETURNING' });
        break;

      case 'RETURNED':
        this._billInEscrow = false;
        this._mode = 'CAPTURE';
        this.emit('device-event', { status: 'RETURNED' });
        break;

      case 'REJECTED':
        this._billInEscrow = false;
        this._mode = 'CAPTURE';
        this.emit('device-event', { status: 'REJECTED' });
        break;
    }
  }

  private _startPolling(): void {
    this._stopPolling();
    if (!config.pollIntervalMs || config.pollIntervalMs <= 0) return;
    this._pollTimer = setInterval(() => {
      void this._pollOnce();
    }, config.pollIntervalMs);
  }

  private _stopPolling(): void {
    if (this._pollTimer) {
      clearInterval(this._pollTimer);
      this._pollTimer = null;
    }
  }

  private async _pollOnce(): Promise<void> {
    if (!this._connected || this._busy) return;
    try {
      await this._sendCommand(this._pollOpts());
    } catch (err: unknown) {
      const appErr = normalizeError(err);
      this.emit('device-event', {
        status: 'ERROR',
        code: appErr.code,
        message: appErr.message,
      });
    }
  }

  private _ensureConnected(): void {
    if (!this._connected || !this._port || !this._port.isOpen) {
      throw new AppError(ERROR_CODES.DEVICE_DISCONNECTED, 'Device is not connected');
    }
  }

  // The poll we repeat while connected: accept + host-controlled escrow when
  // enabled, idle otherwise. `extra` lets a one-shot stack/return bit ride along.
  private _pollOpts(extra: OmnibusOptions = {}): OmnibusOptions {
    return { enable: this._enabled, escrow: this._enabled, ...extra };
  }

  private _classifyPortError(err: Error): ErrorCode {
    const msg = err.message.toLowerCase();
    if (
      msg.includes('no such file') ||
      msg.includes('cannot find')  ||
      msg.includes('file not found')
    ) {
      return ERROR_CODES.PORT_NOT_FOUND;
    }
    return ERROR_CODES.DEVICE_ERROR;
  }
}

export default BillAcceptor;