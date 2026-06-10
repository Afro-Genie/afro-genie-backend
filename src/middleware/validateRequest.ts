import type { NextFunction, Request, Response } from 'express';
import { validationResult } from 'express-validator';
import { ApiError } from './errorHandler';

export const validateRequest = (req: Request, _res: Response, next: NextFunction) => {
  const result = validationResult(req);

  if (!result.isEmpty()) {
    const first = result.array({ onlyFirstError: true })[0];
    return next(new ApiError(first.msg, 'VALIDATION_ERROR', 400));
  }

  return next();
};
