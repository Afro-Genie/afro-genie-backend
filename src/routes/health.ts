import { type NextFunction, type Request, type Response, Router } from 'express';
import { getHealthStatus } from '../services/healthService';

export const healthRouter = Router();

healthRouter.get(
  '/health',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const health = await getHealthStatus();
      const httpStatus = health.status === 'error' ? 503 : 200;
      res.status(httpStatus).json(health);
    } catch (error) {
      next(error);
    }
  }
);
