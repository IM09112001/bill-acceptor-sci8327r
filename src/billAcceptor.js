import { EventEmitter } from "node:events";
import { SerialPort } from "serialport";
import config from "./config.js";
import { AppError, ERROR_CODES } from "./errors.js";
import { buildCommand, parseDeviceResponse } from "./protocol.js";

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
    this.port = null;

    this.emitDeviceEvent("DISCONNECTED");
    return this.getStatus();
  }

  async checkDeviceResponds() {
    await this.sendDeviceCommand("STATUS");
  }

  // ── Serial write/read ─────────────────────────────────────────────────────

  async sendDeviceCommand(method, params = {}) {
    this.ensureConnected();

    if (this.busy) {
      throw new AppError(ERROR_CODES.DEVICE_ERROR, "Device is busy");
    }

    this.busy = true;
    try {
      const command = buildCommand(method, params);
      const response = await this.writeAndRead(command);
      const parsed = parseDeviceResponse(response);
      this.lastRawResponse = parsed.raw;
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

  writeAndRead(command) {
    return new Promise((resolve, reject) => {
      let timer;
      let onData;
      let onError;

      const cleanup = () => {
        clearTimeout(timer);
        this.port.removeListener("data", onData);
        this.port.removeListener("error", onError);
      };

      onData = (chunk) => {
        cleanup();
        resolve(chunk);
      };

      onError = (err) => {
        cleanup();
        reject(new AppError(ERROR_CODES.DEVICE_DISCONNECTED, err.message));
      };

      timer = setTimeout(() => {
        cleanup();
        reject(new AppError(ERROR_CODES.DEVICE_NOT_RESPONDING, "Device did not respond in time"));
      }, config.serialTimeoutMs);

      this.port.once("data", onData);
      this.port.once("error", onError);

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
      const parsed = await this.sendDeviceCommand("STATUS");
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
      await this.sendDeviceCommand("STATUS");
    } catch (err) {
      this.emitDeviceEvent("ERROR", {
        code: (err && err.code) || ERROR_CODES.DEVICE_ERROR,
        message: (err && err.message) || "Poll error",
      });
    }
  }
}

export default BillAcceptor;
