import type { NextFunction, Request, Response } from 'express';
import { logger } from '../lib/logger';

export class ApiError extends Error {
  public readonly code: string;
  public readonly status: number;

  constructor(message: string, code: string, status = 500) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export const notFoundHandler = (_req: Request, _res: Response, next: NextFunction) => {
  next(new ApiError('Route not found', 'NOT_FOUND', 404));
};

export const errorHandler = (
  err: Error | ApiError,
  _req: Request,
  res: Response,
  _next: NextFunction
) => {
  const apiError = err instanceof ApiError
    ? err
    : new ApiError('Internal server error', 'INTERNAL_SERVER_ERROR', 500);

  logger.error({ err }, 'Request failed');

  res.status(apiError.status).json({
    error: apiError.message,
    code: apiError.code
  });
};
