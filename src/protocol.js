import { AppError, ERROR_CODES } from "./errors.js";

// ─── EBDS Protocol — MEI Cashflow SC / SCL8327R ────────────────────────────
//
// Reference: "MEI Cashflow SC Series Customer Interface Manual" (EBDS spec)
//
// Frame layout (host → device and device → host):
//   [STX=0x02] [LEN] [CMD/MSG_TYPE] [DATA...] [ETX=0x03] [CHK]
//
// LEN  — count of bytes from LEN through ETX inclusive = 3 + data.length
// CHK  — XOR of every byte from LEN through ETX inclusive

const STX = 0x02;
const ETX = 0x03;

// ── Frame utilities ───────────────────────────────────────────────────────

function xorChecksum(bytes) {
  return bytes.reduce((acc, b) => acc ^ b, 0);
}

/**
 * Build a complete EBDS frame.
 * @param {number}   cmd  - Command / message-type byte
 * @param {number[]} data - Zero or more data bytes that follow CMD
 * @returns {Buffer}
 */
function buildFrame(cmd, data = []) {
  // LEN = 1(LEN) + 1(CMD) + data.length + 1(ETX)
  const len = 3 + data.length;
  const frame = [STX, len, cmd, ...data, ETX];
  const chk = xorChecksum(frame.slice(1)); // XOR from LEN through ETX
  return Buffer.from([...frame, chk]);
}

/**
 * Validate a received EBDS frame: STX, LEN, ETX position, and XOR checksum.
 * @param {Buffer} buf
 * @returns {boolean}
 */
function validateFrame(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 5) return false;
  if (buf[0] !== STX) return false;
  const len = buf[1];
  // Total frame size = STX(1) + len bytes (LEN..ETX) + CHK(1) = len + 2
  if (buf.length < len + 2) return false;
  if (buf[len] !== ETX) return false; // ETX is at index = buf[1]
  const computed = xorChecksum(buf.slice(1, len + 1));
  return computed === buf[len + 1];
}

// ── Command frame builders ────────────────────────────────────────────────

/**
 * EBDS Poll command (0x10 | ackBit).
 * Every poll also sets the bill-enable mask — the device uses this to decide
 * whether to accept bills.
 *   enableBytes[0..2]: bit-per-denomination mask (0xFF = accept all, 0x00 = reject all)
 * ACK bit: toggles 0→1→0 on every successful host/device exchange.
 */
function buildPollFrame(ackBit, enableBytes) {
  return buildFrame(0x10 | (ackBit & 0x01), enableBytes);
}

// ── Public API ────────────────────────────────────────────────────────────

/**
 * Build the outgoing EBDS command buffer for a given method.
 *
 * @param {string}  method     - One of STATUS | CAPTURE | ENABLE | DISABLE | STACK | RETURN
 * @param {object}  params     - Extra params; STATUS accepts { enableBytes: [b0, b1, b2] }
 * @param {number}  ackBit     - 0 or 1; toggled by BillAcceptor on every successful exchange
 * @returns {Buffer}
 */
function buildCommand(method, params = {}, ackBit = 0) {
  // STATUS uses the caller-supplied enable bytes so that the poll keeps the
  // device in whatever acceptance mode was last configured.
  const eb = params.enableBytes ?? [0x00, 0x00, 0x00];

  switch (method) {
    case "STATUS":  return buildPollFrame(ackBit, eb);
    case "CAPTURE": return buildPollFrame(ackBit, [0xFF, 0xFF, 0xFF]); // enable all bills
    case "ENABLE":  return buildPollFrame(ackBit, [0xFF, 0xFF, 0xFF]);
    case "DISABLE": return buildPollFrame(ackBit, [0x00, 0x00, 0x00]); // reject all bills
    case "STACK":   return buildFrame(0x41 | (ackBit & 0x01));
    case "RETURN":  return buildFrame(0x42 | (ackBit & 0x01));
    default:
      throw new AppError(ERROR_CODES.DEVICE_ERROR, `No EBDS command frame for method: ${method}`);
  }
}

// ── Response parser ───────────────────────────────────────────────────────

/**
 * Parse a raw EBDS device response buffer.
 *
 * Expected device response layout (LEN = 0x09, total 11 bytes):
 *   [0] STX=0x02
 *   [1] LEN=0x09
 *   [2] MSG_TYPE   (0x10 | device ACK bit)
 *   [3] DEV_TYPE   (device type identifier)
 *   [4] DOC_TYPE   (denomination code, 0 = no bill)
 *   [5] STATUS_0   (bill state bits — see below)
 *   [6] STATUS_1   (error / condition bits — see below)
 *   [7] STATUS_2   (reserved / extended)
 *   [8] STATUS_3   (reserved / extended)
 *   [9] ETX=0x03
 *  [10] CHK
 *
 *     TODO: Verify every bit position below against the official
 *     "MEI Cashflow SC Customer Interface Manual" before production use.
 *     These assignments match the standard EBDS specification but may
 *     differ on specific firmware revisions.
 *
 * STATUS_0 bit map (byte at buf[5]):
 *   0x01  Idling      — device idle, waiting
 *   0x02  Accepting   — bill being read
 *   0x04  Escrowed    — bill held, waiting for STACK or RETURN
 *   0x08  Stacking    — bill moving to cassette
 *   0x10  Stacked     — bill accepted into cassette
 *   0x20  Returning   — bill being returned to user
 *   0x40  Returned    — bill returned
 *   0x80  Rejected    — bill rejected
 *
 * STATUS_1 bit map (byte at buf[6]):
 *   0x04  Bill Jammed
 *   0x08  Stacker Full (cassette full)
 *   0x10  Cassette Removed
 *
 * @param {Buffer} buf  - Raw bytes received from the device
 * @returns {{ raw: string, event: string|null, error: string|null, deviceStatus: object }}
 */
function parseDeviceResponse(buf) {
  if (!buf || buf.length === 0) {
    throw new AppError(ERROR_CODES.DEVICE_NOT_RESPONDING, "Empty or missing device response");
  }

  const raw = buf.toString("hex").toUpperCase();

  if (!validateFrame(buf)) {
    return { raw, event: null, error: "DEVICE_ERROR", deviceStatus: {} };
  }

  // ── Extract status bytes (positions fixed for LEN=0x09) ────────────────
  const msgType  = buf[2];
  const docType  = buf[4]; // denomination (0 = no bill present)
  const status0  = buf[5] ?? 0;
  const status1  = buf[6] ?? 0;

  // STATUS_0 — bill state
  const idling    = !!(status0 & 0x01);
  const accepting = !!(status0 & 0x02);
  const escrowed  = !!(status0 & 0x04);
  const stacking  = !!(status0 & 0x08);
  const stacked   = !!(status0 & 0x10);
  const returning = !!(status0 & 0x20);
  const returned  = !!(status0 & 0x40);
  const rejected  = !!(status0 & 0x80);

  // STATUS_1 — error conditions
  const jammed          = !!(status1 & 0x04);
  const cassetteFull    = !!(status1 & 0x08);
  const cassetteRemoved = !!(status1 & 0x10);

  const deviceStatus = {
    msgType, docType,
    idling, accepting, escrowed, stacking, stacked,
    returning, returned, rejected,
    jammed, cassetteFull, cassetteRemoved,
    raw0: status0, raw1: status1,
  };

  // ── Hardware error conditions (highest priority) ────────────────────────
  if (jammed)          return { raw, event: null, error: "BILL_JAMMED",      deviceStatus };
  if (cassetteFull)    return { raw, event: null, error: "CASSETTE_FULL",    deviceStatus };
  if (cassetteRemoved) return { raw, event: null, error: "CASSETTE_REMOVED", deviceStatus };

  // ── Bill lifecycle events ───────────────────────────────────────────────
  let event = null;
  if      (escrowed)  event = "ESCROW";
  else if (stacking)  event = "STACKING";
  else if (stacked)   event = "STACKED";
  else if (returning) event = "RETURNING";
  else if (returned)  event = "RETURNED";
  else if (rejected)  event = "REJECTED";

  return { raw, event, error: null, deviceStatus };
}

export { buildCommand, parseDeviceResponse };
