import { AppError, ERROR_CODES } from "./errors.js";

// TODO: Replace all Buffer.from([]) with real byte frames from the SCI8327R/SCL8327R manual.
// Do NOT invent command bytes.
const COMMANDS = {
  STATUS:  Buffer.from([]),  // TODO: official SCI8327R STATUS command bytes
  CAPTURE: Buffer.from([]),  // TODO: official SCI8327R CAPTURE command bytes
  ENABLE:  Buffer.from([]),  // TODO: official SCI8327R ENABLE command bytes
  DISABLE: Buffer.from([]),  // TODO: official SCI8327R DISABLE command bytes
  STACK:   Buffer.from([]),  // TODO: official SCI8327R STACK command bytes
  RETURN:  Buffer.from([]),  // TODO: official SCI8327R RETURN command bytes
};

function buildCommand(method, params = {}) {
  const cmd = COMMANDS[method];
  if (cmd === undefined) {
    throw new AppError(ERROR_CODES.UNKNOWN_METHOD, `Unknown protocol method: ${method}`);
  }
  if (cmd.length === 0) {
    throw new AppError(
      ERROR_CODES.DEVICE_ERROR,
      `RS232 command for ${method} is not implemented. Add official SCI8327R/SCL8327R bytes in protocol.js.`
    );
  }
  return cmd;
}

function parseDeviceResponse(buffer) {
  if (!buffer || buffer.length === 0) {
    throw new AppError(ERROR_CODES.DEVICE_NOT_RESPONDING, "Empty or missing device response");
  }

  const raw = buffer.toString("hex").toUpperCase();

  // TODO: Parse real SCI8327R/SCL8327R response bytes per official manual.
  // Detect these events based on status byte(s):
  //   ESCROW    — bill inserted, waiting for decision
  //   STACKING  — bill moving to cassette
  //   STACKED   — bill accepted
  //   RETURNING — bill being returned
  //   RETURNED  — bill returned
  //   REJECTED  — bill rejected
  // Detect these errors:
  //   BILL_JAMMED       — bill jammed in transport
  //   CASSETTE_FULL     — cassette is full
  //   CASSETTE_REMOVED  — cassette removed
  //   DEVICE_ERROR      — generic device error

  return {
    raw,
    event: null,     // TODO: set to event name string when detected
    error: null,     // TODO: set to ERROR_CODES value when device reports error
    deviceStatus: {},
  };
}

export { COMMANDS, buildCommand, parseDeviceResponse };
