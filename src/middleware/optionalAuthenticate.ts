import type { NextFunction, Request, Response } from "express";
import { authenticate } from "./auth";

export const optionalAuthenticate = (req: Request, res: Response, next: NextFunction) => {
  const header = req.headers.authorization;
  if (!header) return next();
  return authenticate(req, res, next);
};
