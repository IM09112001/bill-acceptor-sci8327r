const STX = 0x02;
const ETX = 0x03;

export function xorChecksum(bytes: Buffer): number {
  let result = 0;
  for (let i = 0; i < bytes.length; i++) {
    result ^= bytes[i];
  }
  return result;
}

// length = STX + LEN + CMD + data + ETX + CHK
export function buildFrame(cmd: number, data: number[] = []): Buffer {
  const length = 5 + data.length;
  const body = Buffer.from([STX, length, cmd, ...data, ETX]);
  const chk = xorChecksum(body.subarray(1)); // everything except STX and the CHK itself
  return Buffer.concat([body, Buffer.from([chk])]);
}

export function validateFrame(buf: Buffer): boolean {
  if (buf[0] !== STX) return false;
  if (buf.length < 5) return false;

  const totalLen = buf[1];
  if (buf.length < totalLen) return false;
  if (buf[totalLen - 2] !== ETX) return false;

  const computed = xorChecksum(buf.subarray(1, totalLen - 1));
  return computed === buf[totalLen - 1];
}