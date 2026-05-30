import { validateFrame } from './frame';
import { AppError } from '../errors';
import {
  ERROR_CODES,
  type ParsedDeviceResponse,
  type DeviceStatusBits,
  type DeviceEventName,
} from '../types';

export function parseDeviceResponse(buf: Buffer): ParsedDeviceResponse {
  if (!buf || buf.length === 0) {
    throw new AppError(ERROR_CODES.DEVICE_NOT_RESPONDING, 'Empty device response');
  }

  const raw = buf.toString('hex').toUpperCase();

  if (!validateFrame(buf)) {
    return { raw, event: null, error: 'DEVICE_ERROR', deviceStatus: makeEmptyStatus() };
  }

  const msgType = buf[2];

  // Standard omnibus reply: the three status data bytes follow the header,
  // so they live at indices 3, 4 and 5 (not 4/5/6).
  const data0 = buf[3] ?? 0; // bill movement
  const data1 = buf[4] ?? 0; // faults / cassette
  const data2 = buf[5] ?? 0; // device state + note value

  // Data 0 — movement
  const idling    = !!(data0 & 0x01);
  const accepting = !!(data0 & 0x02);
  const escrowed  = !!(data0 & 0x04);
  const stacking  = !!(data0 & 0x08);
  const stacked   = !!(data0 & 0x10);
  const returning = !!(data0 & 0x20);
  const returned  = !!(data0 & 0x40);

  // Data 1 — faults. Note: "rejected" lives here (bit 1), not in Data 0.
  const rejected        = !!(data1 & 0x02);
  const jammed          = !!(data1 & 0x04);
  const cassetteFull    = !!(data1 & 0x08);
  const cassettePresent = !!(data1 & 0x10); // bit set = cassette/box attached
  const cassetteRemoved = !cassettePresent;

  // Data 2 — note value is encoded in bits 3..5 (0 = no note in the transport).
  const docType = (data2 >> 3) & 0x07;

  const deviceStatus: DeviceStatusBits = {
    msgType, docType,
    idling, accepting, escrowed, stacking, stacked,
    returning, returned, rejected,
    jammed, cassetteFull, cassetteRemoved,
    raw0: data0,
    raw1: data1,
  };

  // hardware errors take priority over bill state
  if (jammed)          return { raw, event: null, error: 'BILL_JAMMED',      deviceStatus };
  if (cassetteFull)    return { raw, event: null, error: 'CASSETTE_FULL',    deviceStatus };
  if (cassetteRemoved) return { raw, event: null, error: 'CASSETTE_REMOVED', deviceStatus };

  let event: DeviceEventName | null = null;
  if      (escrowed)  event = 'ESCROW';
  else if (stacking)  event = 'STACKING';
  else if (stacked)   event = 'STACKED';
  else if (returning) event = 'RETURNING';
  else if (returned)  event = 'RETURNED';
  else if (rejected)  event = 'REJECTED';

  return { raw, event, error: null, deviceStatus };
}

function makeEmptyStatus(): DeviceStatusBits {
  return {
    msgType: 0, docType: 0,
    idling: false, accepting: false, escrowed: false, stacking: false,
    stacked: false, returning: false, returned: false, rejected: false,
    jammed: false, cassetteFull: false, cassetteRemoved: false,
    raw0: 0, raw1: 0,
  };
}
