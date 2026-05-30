import { buildFrame } from './frame';

const OMNIBUS = 0x10; // standard omnibus command; bit 0 carries the ACK toggle

// Data byte 0 — denomination enable mask (bit0..bit6 = note types 1..7).
const ENABLE_ALL = 0x7f;
const ENABLE_NONE = 0x00;

// Data byte 1 — operating mode bits.
const ESCROW_MODE = 1 << 4; // 0x10  hold an accepted note in escrow for a host decision
const STACK_BIT = 1 << 5; //   0x20  stack the note currently in escrow
const RETURN_BIT = 1 << 6; //  0x40  return the note currently in escrow

export interface OmnibusOptions {
  enable?: boolean; // accept notes (sets the denomination mask)
  escrow?: boolean; // hold accepted notes in escrow instead of letting the device stack them
  stack?: boolean; //  one-shot: stack the escrowed note
  return?: boolean; // one-shot: return the escrowed note
}

export function buildOmnibus(opts: OmnibusOptions = {}, ackBit: 0 | 1 = 0): Buffer {
  const bit = (ackBit & 0x01) as 0 | 1;

  const data0 = opts.enable ? ENABLE_ALL : ENABLE_NONE;

  let data1 = opts.escrow ? ESCROW_MODE : 0x00;
  if (opts.stack) data1 |= STACK_BIT;
  if (opts.return) data1 |= RETURN_BIT;

  const data2 = 0x00; // reserved for future use; must be 0x00

  return buildFrame(OMNIBUS | bit, [data0, data1, data2]);
}
