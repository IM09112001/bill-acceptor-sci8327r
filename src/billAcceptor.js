import { EventEmitter } from "node:events";
import { SerialPort } from "serialport";
import config from "./config.js";
import { AppError, ERROR_CODES } from "./errors.js";
import { buildCommand, parseDeviceResponse } from "./protocol.js";

const EBDS_STX = 0x02;

class BillAcceptor extends EventEmitter {
  constructor() {
    super();
    this.port = null;
    this.connected = false;
    this.mode = "CLOSED";
    this.enabled = false;
    this.autoStack = false;
    this.billInEscrow = false;
    this.lastRawResponse = null;
    this.busy = false;
    this.pollTimer = null;
    this.ackBit = 0; // EBDS ACK bit — toggles 0↔1 on every successful exchange
  }

  getStatus() {
    return {
      connected: this.connected,
      mode: this.mode,
      enabled: this.enabled,
      autoStack: this.autoStack,
      billInEscrow: this.billInEscrow,
      serialPort: config.serial.path,
      lastRawResponse: this.lastRawResponse,
    };
  }

  emitDeviceEvent(event, data = {}) {
    this.emit("device-event", { event, data, status: this.getStatus() });
  }

  ensureConnected() {
    if (!this.connected || !this.port || !this.port.isOpen) {
      throw new AppError(ERROR_CODES.DEVICE_DISCONNECTED, "Device is not connected");
    }
  }

  /** Returns current bill-enable bytes based on enabled state. */
  _enableBytes() {
    return this.enabled ? [0xFF, 0xFF, 0xFF] : [0x00, 0x00, 0x00];
  }

  // ── Open / Close ──────────────────────────────────────────────────────────

  async open() {
    if (this.connected) return this.getStatus();

    this.mode = "OPENING";

    const port = new SerialPort({
      path: config.serial.path,
      baudRate: config.serial.baudRate,
      dataBits: config.serial.dataBits,
      stopBits: config.serial.stopBits,
      parity: config.serial.parity,
      autoOpen: false,
    });

    port.on("error", (err) => {
      this.emitDeviceEvent("ERROR", { code: ERROR_CODES.DEVICE_ERROR, message: err.message });
    });

    port.on("close", () => {
      this.stopPolling();
      if (this.connected) {
        this.connected = false;
        this.mode = "CLOSED";
        this.enabled = false;
        this.billInEscrow = false;
        this.ackBit = 0;
        this.emitDeviceEvent("DISCONNECTED");
      }
    });

    await new Promise((resolve, reject) => {
      port.open((err) => {
        if (err) {
          this.mode = "CLOSED";
          const code = err.message.includes("No such file") || err.message.includes("cannot find")
            ? ERROR_CODES.PORT_NOT_FOUND
            : ERROR_CODES.DEVICE_ERROR;
          reject(new AppError(code, err.message));
        } else {
          resolve();
        }
      });
    });

    this.port = port;
    this.connected = true;
    this.mode = "OPEN";
    this.ackBit = 0; // reset ACK sequence for fresh connection

    try {
      await this.checkDeviceResponds();
    } catch (err) {
      this.connected = false;
      this.mode = "CLOSED";
      port.close(() => {});
      this.port = null;
      throw err;
    }

    this.emitDeviceEvent("CONNECTED");
    this.startPolling();
    return this.getStatus();
  }

  async close() {
    this.stopPolling();

    if (this.port && this.port.isOpen) {
      await new Promise((resolve) => this.port.close(() => resolve()));
    }

    this.connected = false;
    this.mode = "CLOSED";
    this.enabled = false;
    this.billInEscrow = false;
    this.ackBit = 0;
    this.port = null;

    this.emitDeviceEvent("DISCONNECTED");
    return this.getStatus();
  }

  async checkDeviceResponds() {
    // Poll with all-zero enable bytes — just verify the device is alive
    await this.sendDeviceCommand("STATUS", { enableBytes: [0x00, 0x00, 0x00] });
  }

  // ── Serial write/read ─────────────────────────────────────────────────────

  async sendDeviceCommand(method, params = {}) {
    this.ensureConnected();

    if (this.busy) {
      throw new AppError(ERROR_CODES.DEVICE_ERROR, "Device is busy");
    }

    this.busy = true;
    try {
      const command = buildCommand(method, params, this.ackBit);
      const response = await this.writeAndRead(command);
      const parsed = parseDeviceResponse(response);
      this.lastRawResponse = parsed.raw;
      this.ackBit ^= 1; // toggle after every successful byte exchange
      this.applyParsedResponse(parsed);
      if (parsed.error) {
        const code = ERROR_CODES[parsed.error] ?? ERROR_CODES.DEVICE_ERROR;
        throw new AppError(code, `Device reported error: ${parsed.error}`);
      }
      return parsed;
    } finally {
      this.busy = false;
    }
  }

  /**
   * Write a command to the serial port and accumulate the full EBDS response
   * frame before resolving.
   *
   * EBDS frames: [STX=0x02][LEN][...][ETX=0x03][CHK]
   * Total frame size = LEN + 2 (STX byte + LEN bytes + CHK byte).
   * Bytes are accumulated across multiple `data` events until the expected
   * frame length is reached.
   */
  writeAndRead(command) {
    return new Promise((resolve, reject) => {
      let timer;
      let accumulated = Buffer.alloc(0);

      const cleanup = () => {
        clearTimeout(timer);
        this.port.removeListener("data", onData);
        this.port.removeListener("error", onError);
      };

      const onData = (chunk) => {
        accumulated = Buffer.concat([accumulated, chunk]);

        // Need at least STX + LEN before we know the expected total length
        if (accumulated.length < 2) return;

        // Discard bytes before STX
        const stxIndex = accumulated.indexOf(EBDS_STX);
        if (stxIndex < 0) { accumulated = Buffer.alloc(0); return; }
        if (stxIndex > 0) accumulated = accumulated.slice(stxIndex);
        if (accumulated.length < 2) return;

        // Total = STX(1) + LEN_value bytes + CHK(1)
        const expectedLen = accumulated[1] + 2;
        if (accumulated.length >= expectedLen) {
          cleanup();
          resolve(accumulated.slice(0, expectedLen));
        }
      };

      const onError = (err) => {
        cleanup();
        reject(new AppError(ERROR_CODES.DEVICE_DISCONNECTED, err.message));
      };

      timer = setTimeout(() => {
        cleanup();
        reject(new AppError(ERROR_CODES.DEVICE_NOT_RESPONDING, "Device did not respond in time"));
      }, config.serialTimeoutMs);

      this.port.on("data", onData);
      this.port.on("error", onError);

      this.port.write(command, (err) => {
        if (err) {
          cleanup();
          reject(new AppError(ERROR_CODES.DEVICE_DISCONNECTED, err.message));
        }
      });
    });
  }

  applyParsedResponse(parsed) {
    if (parsed.error) this.handleDeviceError(parsed.error);
    else if (parsed.event) this.handleDeviceEvent(parsed.event, parsed);
  }

  handleDeviceError(errorCode) {
    const codeMap = {
      BILL_JAMMED: ERROR_CODES.BILL_JAMMED,
      CASSETTE_FULL: ERROR_CODES.CASSETTE_FULL,
      CASSETTE_REMOVED: ERROR_CODES.CASSETTE_REMOVED,
    };
    const code = codeMap[errorCode] || ERROR_CODES.DEVICE_ERROR;
    this.mode = "ERROR";
    this.emitDeviceEvent("ERROR", { code, message: errorCode });
  }

  handleDeviceEvent(event, parsed) {
    switch (event) {
      case "ESCROW":
        this.billInEscrow = true;
        this.mode = "ESCROW";
        this.emitDeviceEvent("ESCROW", parsed.deviceStatus);
        if (this.autoStack) this.stack().catch(() => {});
        break;
      case "STACKING":
        this.mode = "STACKING";
        this.emitDeviceEvent("STACKING");
        break;
      case "STACKED":
        this.billInEscrow = false;
        this.mode = "CAPTURE";
        this.emitDeviceEvent("STACKED");
        break;
      case "RETURNING":
        this.mode = "RETURNING";
        this.emitDeviceEvent("RETURNING");
        break;
      case "RETURNED":
        this.billInEscrow = false;
        this.mode = "CAPTURE";
        this.emitDeviceEvent("RETURNED");
        break;
      case "REJECTED":
        this.billInEscrow = false;
        this.mode = "CAPTURE";
        this.emitDeviceEvent("REJECTED");
        break;
    }
  }

  // ── Public command methods ────────────────────────────────────────────────

  async status() {
    if (!this.connected) return this.getStatus();
    try {
      const parsed = await this.sendDeviceCommand("STATUS", { enableBytes: this._enableBytes() });
      return { ...this.getStatus(), deviceResponse: parsed };
    } catch (err) {
      return { ...this.getStatus(), error: { code: err.code, message: err.message } };
    }
  }

  async capture() {
    this.ensureConnected();
    const parsed = await this.sendDeviceCommand("CAPTURE");
    this.enabled = true;
    this.mode = "CAPTURE";
    return { ...this.getStatus(), deviceResponse: parsed };
  }

  async enable() {
    this.ensureConnected();
    const parsed = await this.sendDeviceCommand("ENABLE");
    this.enabled = true;
    return { ...this.getStatus(), deviceResponse: parsed };
  }

  async disable() {
    this.ensureConnected();
    const parsed = await this.sendDeviceCommand("DISABLE");
    this.enabled = false;
    this.mode = "DISABLED";
    return { ...this.getStatus(), deviceResponse: parsed };
  }

  async stack() {
    this.ensureConnected();
    if (!this.billInEscrow) {
      throw new AppError(ERROR_CODES.NO_ESCROW, "Cannot stack: no bill in escrow");
    }
    const parsed = await this.sendDeviceCommand("STACK");
    this.emitDeviceEvent("STACKING");
    return { ...this.getStatus(), deviceResponse: parsed };
  }

  async returnBill() {
    this.ensureConnected();
    if (!this.billInEscrow) {
      throw new AppError(ERROR_CODES.NO_ESCROW, "Cannot return: no bill in escrow");
    }
    const parsed = await this.sendDeviceCommand("RETURN");
    this.emitDeviceEvent("RETURNING");
    return { ...this.getStatus(), deviceResponse: parsed };
  }

  async setAutoStack(enabled) {
    this.autoStack = Boolean(enabled);
    return this.getStatus();
  }

  // ── Polling ───────────────────────────────────────────────────────────────

  startPolling() {
    this.stopPolling();
    if (!config.pollIntervalMs || config.pollIntervalMs <= 0) return;
    this.pollTimer = setInterval(() => this.pollOnce(), config.pollIntervalMs);
  }

  stopPolling() {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  async pollOnce() {
    if (!this.connected || this.busy) return;
    try {
      // Pass current enable state so polling maintains whatever mode is active
      await this.sendDeviceCommand("STATUS", { enableBytes: this._enableBytes() });
    } catch (err) {
      this.emitDeviceEvent("ERROR", {
        code: (err && err.code) || ERROR_CODES.DEVICE_ERROR,
        message: (err && err.message) || "Poll error",
      });
    }
  }
}

export default BillAcceptor;
