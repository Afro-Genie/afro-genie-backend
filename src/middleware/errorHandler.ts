import type { NextFunction, Request, Response } from 'express';
import { Prisma } from '@prisma/client';
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

/**
 * Map known Prisma database errors to friendly HTTP responses instead of
 * leaking them as generic 500 Internal Server Errors.
 */
const prunePrismaError = (err: Prisma.PrismaClientKnownRequestError): ApiError => {
  switch (err.code) {
    case 'P2002': {
      const target = Array.isArray(err.meta?.target) ? (err.meta?.target as string[]).join(', ') : 'record';
      return new ApiError(`A record with this ${target} already exists`, 'CONFLICT', 409);
    }
    case 'P2025':
      return new ApiError('Record not found', 'NOT_FOUND', 404);
    case 'P2003':
      return new ApiError('Referenced record does not exist', 'BAD_REQUEST', 400);
    case 'P2011':
    case 'P2012':
    case 'P2014':
      return new ApiError('Invalid or missing data for a required field', 'BAD_REQUEST', 400);
    case 'P2000':
      return new ApiError('Provided value is too long for its column', 'BAD_REQUEST', 400);
    case 'P1001':
      return new ApiError('Database unavailable, please try again', 'SERVICE_UNAVAILABLE', 503);
    default:
      return new ApiError('Database error', 'DB_ERROR', 500);
  }
};

export const notFoundHandler = (_req: Request, _res: Response, next: NextFunction) => {
  next(new ApiError('Route not found', 'NOT_FOUND', 404));
};

export const errorHandler = (
  err: Error | ApiError,
  _req: Request,
  res: Response,
  _next: NextFunction
) => {
  const apiError =
    err instanceof ApiError
      ? err
      : err instanceof Prisma.PrismaClientKnownRequestError
        ? prunePrismaError(err)
        : new ApiError('Internal server error', 'INTERNAL_SERVER_ERROR', 500);

  logger.error({ err }, 'Request failed');

  res.status(apiError.status).json({
    error: apiError.message,
    code: apiError.code
  });
};
