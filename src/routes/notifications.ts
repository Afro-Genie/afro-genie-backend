import type { NextFunction, Request, Response } from 'express';
import { Router } from 'express';
import { param, query } from 'express-validator';
import { authenticate } from '../middleware/auth';
import { validateRequest } from '../middleware/validateRequest';
import {
  getUnreadCount,
  listNotifications,
  markNotificationRead,
} from '../services/notificationService';
import type { AuthUser } from '../types/auth';

export const notificationsRouter = Router();

// ---------------------------------------------------------------------------
// GET /api/users/me/notifications?page=&limit=
// Authenticated. Paginated notification feed for the signed-in user.
// ---------------------------------------------------------------------------
notificationsRouter.get(
  '/users/me/notifications',
  authenticate,
  [
    query('page').optional().isInt({ min: 1 }).toInt(),
    query('limit').optional().isInt({ min: 1, max: 50 }).toInt(),
    validateRequest,
  ],
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = req.user as AuthUser;
      const page = Number(req.query.page) || 1;
      const limit = Number(req.query.limit) || 20;
      const result = await listNotifications(user.id, page, limit);
      return res.status(200).json(result);
    } catch (err) {
      return next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// GET /api/users/me/notifications/unread-count
// Authenticated. Unread notification count for the badge.
// ---------------------------------------------------------------------------
notificationsRouter.get(
  '/users/me/notifications/unread-count',
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = req.user as AuthUser;
      const count = await getUnreadCount(user.id);
      return res.status(200).json({ count });
    } catch (err) {
      return next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// PATCH /api/users/me/notifications/:id/read
// Authenticated. Marks a notification as read.
// ---------------------------------------------------------------------------
notificationsRouter.patch(
  '/users/me/notifications/:id/read',
  authenticate,
  [param('id').isString().notEmpty().withMessage('Notification id is required'), validateRequest],
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = req.user as AuthUser;
      const result = await markNotificationRead(user.id, req.params.id);
      return res.status(200).json(result);
    } catch (err) {
      return next(err);
    }
  },
);
