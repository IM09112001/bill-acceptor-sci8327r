import { ERROR_CODES, type ErrorCode } from '../types';

export class AppError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly details: unknown = null,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

// wraps any thrown value into an AppError so catch blocks always have a typed error
export function normalizeError(err: unknown): AppError {
  if (err instanceof AppError) return err;
  if (err instanceof Error)    return new AppError(ERROR_CODES.INTERNAL_ERROR, err.message);
  return new AppError(ERROR_CODES.INTERNAL_ERROR, String(err));
}