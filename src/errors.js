const ERROR_CODES = {
  INVALID_JSON: "INVALID_JSON",
  WRONG_DEVICE: "WRONG_DEVICE",
  MISSING_ID: "MISSING_ID",
  UNKNOWN_METHOD: "UNKNOWN_METHOD",
  INVALID_PARAMS: "INVALID_PARAMS",
  PORT_NOT_FOUND: "PORT_NOT_FOUND",
  DEVICE_NOT_RESPONDING: "DEVICE_NOT_RESPONDING",
  DEVICE_DISCONNECTED: "DEVICE_DISCONNECTED",
  NO_ESCROW: "NO_ESCROW",
  BILL_JAMMED: "BILL_JAMMED",
  CASSETTE_FULL: "CASSETTE_FULL",
  CASSETTE_REMOVED: "CASSETTE_REMOVED",
  DEVICE_ERROR: "DEVICE_ERROR",
  INTERNAL_ERROR: "INTERNAL_ERROR",
};

class AppError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.details = details;
    this.isOperational = true;
  }
}

function normalizeError(error) {
  try {
    if (error && error.isOperational) return error;
    return new AppError(
      ERROR_CODES.INTERNAL_ERROR,
      (error && error.message) || "Internal error"
    );
  } catch {
    return new AppError(ERROR_CODES.INTERNAL_ERROR, "Internal error");
  }
}

export { ERROR_CODES, AppError, normalizeError };
