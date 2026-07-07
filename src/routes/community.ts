import type { NextFunction, Request, Response } from 'express';
import { Router } from 'express';
import { body, param, query } from 'express-validator';
import { authenticate, requireRole } from '../middleware/auth';
import { validateRequest } from '../middleware/validateRequest';
import { communityService } from '../services/communityService';
import type { AuthUser } from '../types/auth';

export const communityRouter = Router();

// ── Categories ────────────────────────────────────────────────
communityRouter.get(
  '/community/categories',
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const categories = await communityService.listCategories();
      res.json(categories);
    } catch (error) {
      next(error);
    }
  },
);

communityRouter.post(
  '/community/categories/:id/join',
  authenticate,
  [param('id').isString(), validateRequest],
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = req.user as AuthUser;
      const membership = await communityService.joinCategory(user.id, req.params.id);
      res.status(201).json(membership);
    } catch (error) {
      next(error);
    }
  },
);

// ── Topics ────────────────────────────────────────────────────
communityRouter.get(
  '/community/topics',
  [
    query('categoryId').optional().isString(),
    query('sort').optional().isIn(['hot', 'new', 'top']),
    query('page').optional().isInt({ min: 1 }).toInt(),
    query('limit').optional().isInt({ min: 1, max: 50 }).toInt(),
    query('search').optional().isString(),
    validateRequest,
  ],
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await communityService.listTopics(req.query as any);
      res.json(result);
    } catch (error) {
      next(error);
    }
  },
);

communityRouter.post(
  '/community/topics',
  authenticate,
  requireRole('MODERATOR', 'ADMIN'),
  [
    body('title').isString().isLength({ min: 1, max: 255 }).withMessage('Title is required (max 255 chars)'),
    body('content').isString().isLength({ min: 1 }).withMessage('Content is required'),
    body('forumCategoryId').isString().withMessage('Forum category is required'),
    body('songId').optional().isString(),
    body('artistId').optional().isString(),
    validateRequest,
  ],
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = req.user as AuthUser;
      const topic = await communityService.createTopic(req.body, user.id);
      res.status(201).json(topic);
    } catch (error) {
      next(error);
    }
  },
);

communityRouter.get(
  '/community/topics/:id',
  [param('id').isString(), validateRequest],
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const topic = await communityService.getTopic(req.params.id);
      res.json(topic);
    } catch (error) {
      next(error);
    }
  },
);

communityRouter.post(
  '/community/topics/:topicId/comments',
  authenticate,
  [
    param('topicId').isString(),
    body('content').isString().isLength({ min: 1 }).withMessage('Content is required'),
    body('parentCommentId').optional().isString(),
    validateRequest,
  ],
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = req.user as AuthUser;
      const comment = await communityService.createComment(
        { topicId: req.params.topicId, content: req.body.content, parentCommentId: req.body.parentCommentId },
        user.id,
      );
      res.status(201).json(comment);
    } catch (error) {
      next(error);
    }
  },
);

// ── Moderation ────────────────────────────────────────────────
communityRouter.patch(
  '/community/topics/:id/pin',
  authenticate,
  requireRole('MODERATOR', 'ADMIN'),
  [param('id').isString(), validateRequest],
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await communityService.pinTopic(req.params.id);
      res.json(result);
    } catch (error) {
      next(error);
    }
  },
);

communityRouter.patch(
  '/community/topics/:id/lock',
  authenticate,
  requireRole('MODERATOR', 'ADMIN'),
  [param('id').isString(), validateRequest],
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await communityService.lockTopic(req.params.id);
      res.json(result);
    } catch (error) {
      next(error);
    }
  },
);

communityRouter.delete(
  '/community/topics/:id',
  authenticate,
  requireRole('MODERATOR', 'ADMIN'),
  [param('id').isString(), validateRequest],
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await communityService.softDeleteTopic(req.params.id);
      res.json(result);
    } catch (error) {
      next(error);
    }
  },
);

// ── Voting ────────────────────────────────────────────────────
communityRouter.post(
  '/community/vote/topic',
  authenticate,
  [
    body('topicId').isString().withMessage('Topic ID is required'),
    body('voteType').isIn(['UPVOTE', 'DOWNVOTE']).withMessage('Vote type must be UPVOTE or DOWNVOTE'),
    validateRequest,
  ],
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = req.user as AuthUser;
      const result = await communityService.voteOnTopic(user.id, req.body.topicId, req.body.voteType);
      res.json(result);
    } catch (error) {
      next(error);
    }
  },
);

communityRouter.post(
  '/community/vote/comment',
  authenticate,
  [
    body('commentId').isString().withMessage('Comment ID is required'),
    body('voteType').isIn(['UPVOTE', 'DOWNVOTE']).withMessage('Vote type must be UPVOTE or DOWNVOTE'),
    validateRequest,
  ],
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = req.user as AuthUser;
      const result = await communityService.voteOnComment(user.id, req.body.commentId, req.body.voteType);
      res.json(result);
    } catch (error) {
      next(error);
    }
  },
);
