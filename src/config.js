import "dotenv/config";

function getStringEnv(name, defaultValue) {
  const val = process.env[name];
  return val !== undefined && val !== "" ? val : defaultValue;
}

function getNumberEnv(name, defaultValue) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return defaultValue;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`Config error: ${name} must be a positive number, got "${raw}"`);
  }
  return n;
}

const config = {
  ws: {
    host: getStringEnv("WS_HOST", "localhost"),
    port: getNumberEnv("WS_PORT", 8080),
  },
  serial: {
    path: getStringEnv("SERIAL_PORT", "COM3"),
    baudRate: getNumberEnv("SERIAL_BAUD_RATE", 9600),
    dataBits: getNumberEnv("SERIAL_DATA_BITS", 8),
    stopBits: getNumberEnv("SERIAL_STOP_BITS", 1),
    parity: getStringEnv("SERIAL_PARITY", "none"),
  },
  serialTimeoutMs: getNumberEnv("SERIAL_TIMEOUT_MS", 1500),
  pollIntervalMs: getNumberEnv("POLL_INTERVAL_MS", 300),
};

export default config;
