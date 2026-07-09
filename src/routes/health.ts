import { type NextFunction, type Request, type Response, Router } from 'express';
import { query } from 'express-validator';
import { getHealthStatus } from '../services/healthService';
import { validateRequest } from '../middleware/validateRequest';

export const healthRouter = Router();

healthRouter.get(
  '/health',
  [query('verbose').optional().isBoolean().withMessage('verbose must be a boolean')],
  validateRequest,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const verbose = req.query.verbose === 'true';
      const health = await getHealthStatus(verbose);
      res.status(200).json(health);
    } catch (error) {
      next(error);
    }
  }
);
