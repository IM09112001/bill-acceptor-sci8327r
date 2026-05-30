import 'dotenv/config';

interface SerialConfig {
  readonly path: string;
  readonly baudRate: number;
  readonly dataBits: 5 | 6 | 7 | 8;
  readonly stopBits: 1 | 1.5 | 2;
  readonly parity: 'none' | 'even' | 'odd' | 'mark' | 'space';
}

export interface AppConfig {
  readonly serial: SerialConfig;
  readonly ws: { readonly host: string; readonly port: number };
  readonly serialTimeoutMs: number;
  readonly pollIntervalMs: number;
}

function readString(name: string, defaultValue: string): string {
  const v = process.env[name]?.trim();
  return (v !== undefined && v !== '') ? v : defaultValue;
}

function readPositiveNumber(name: string, defaultValue: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return defaultValue;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`Config error: ${name} must be a positive number, got "${raw}"`);
  }
  return n;
}

function readEnum<T extends string | number>(
  name: string,
  allowed: readonly T[],
  defaultValue: T,
): T {
  const raw = process.env[name]?.trim();
  if (!raw) return defaultValue;

  const isNumericTuple = typeof allowed[0] === 'number';
  const parsedValue = isNumericTuple ? Number(raw) : raw;

  if (!(allowed as readonly unknown[]).includes(parsedValue)) {
    throw new Error(
      `Config error: ${name} must be one of [${allowed.join(', ')}], got "${raw}"`,
    );
  }

  return parsedValue as T;
}

const config: AppConfig = {
  serial: {
    path: readString('SERIAL_PORT', 'COM3'),
    baudRate: readPositiveNumber('SERIAL_BAUD_RATE', 9600),
    dataBits: readEnum('SERIAL_DATA_BITS', [5, 6, 7, 8] as const, 8),
    stopBits: readEnum('SERIAL_STOP_BITS', [1, 1.5, 2] as const, 1),
    parity: readEnum(
      'SERIAL_PARITY',
      ['none', 'even', 'odd', 'mark', 'space'] as const,
      'even',
    ),
  },
  ws: {
    host: readString('WS_HOST', 'localhost'),
    port: readPositiveNumber('WS_PORT', 8080),
  },
  serialTimeoutMs: readPositiveNumber('SERIAL_TIMEOUT_MS', 1500),
  pollIntervalMs: readPositiveNumber('POLL_INTERVAL_MS', 200),
};

export default config;