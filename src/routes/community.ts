import type { NextFunction, Request, Response } from 'express';
import { Router } from 'express';
import { body, param, query } from 'express-validator';
import { authenticate, optionalAuth, requireRole } from '../middleware/auth';
import { validateRequest } from '../middleware/validateRequest';
import { communityService } from '../services/communityService';
import { getLeaderboard, getUserRank, queueReward } from '../services/rewardService';
import type { AuthUser } from '../types/auth';

export const communityRouter = Router();

// ── Categories ────────────────────────────────────────────────
communityRouter.get(
  '/community/categories',
  optionalAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = (req.user as AuthUser | undefined)?.id;
      const categories = await communityService.listCategories(userId);
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
  optionalAuth,
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
      const userId = (req.user as AuthUser | undefined)?.id;
      const result = await communityService.listTopics(req.query as any, userId);
      res.json(result);
    } catch (error) {
      next(error);
    }
  },
);

communityRouter.post(
  '/community/topics',
  authenticate,
  [
    body('title').isString().isLength({ min: 1, max: 255 }).withMessage('Title is required (max 255 chars)'),
    body('content').isString().isLength({ min: 1 }).withMessage('Content is required'),
    body('forumCategoryId').isString().withMessage('Forum category is required'),
    body('songId').optional().isString(),
    body('artistId').optional().isString(),
    body('imageUrl').optional({ values: 'falsy' }).isString(),
    body('image').optional({ values: 'falsy' }).isString(),
    body('attachmentUrl').optional({ values: 'falsy' }).isString(),
    body('fileUrl').optional({ values: 'falsy' }).isString(),
    body('isModeratorOnly').optional().isBoolean(),
    validateRequest,
  ],
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = req.user as AuthUser;
      const isModeratorOnly = req.body.isModeratorOnly === true;
      if (isModeratorOnly && user.role !== 'MODERATOR' && user.role !== 'ADMIN') {
        return res.status(403).json({ error: 'Only moderators can create moderator-only topics', code: 'FORBIDDEN' });
      }
      const imageUrl = req.body.imageUrl || req.body.image || req.body.attachmentUrl || req.body.fileUrl || null;
      const topic = await communityService.createTopic({ ...req.body, imageUrl, isModeratorOnly }, user.id);
      res.status(201).json(topic);
    } catch (error) {
      next(error);
    }
  },
);

communityRouter.get(
  '/community/topics/:id',
  optionalAuth,
  [param('id').isString(), validateRequest],
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = (req.user as AuthUser | undefined)?.id;
      const topic = await communityService.getTopic(req.params.id, userId);
      try {
        const { communityRedesignService } = await import('../services/communityRedesignService.js');
        await communityRedesignService.recordTopicView(req.params.id, userId);
      } catch (e) {
        // ignore view tracking errors
      }
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
      const user = req.user as AuthUser;
      const result = await communityService.pinTopic(req.params.id, user.id);
      await queueReward(user.id, 2, 'Topic pinned', 'MODERATOR_ACTION', `mod-pin:${req.params.id}:${user.id}`);
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
      const user = req.user as AuthUser;
      const result = await communityService.lockTopic(req.params.id, user.id);
      await queueReward(user.id, 2, 'Topic locked', 'MODERATOR_ACTION', `mod-lock:${req.params.id}:${user.id}`);
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
      const user = req.user as AuthUser;
      const result = await communityService.softDeleteTopic(req.params.id, user.id);
      await queueReward(user.id, 1, 'Topic deleted', 'MODERATOR_ACTION', `mod-delete:${req.params.id}:${user.id}`);
      res.json(result);
    } catch (error) {
      next(error);
    }
  },
);

communityRouter.patch(
  '/community/topics/:id',
  authenticate,
  requireRole('MODERATOR', 'ADMIN'),
  [
    param('id').isString(),
    body('title').optional().isString(),
    body('content').optional().isString(),
    validateRequest,
  ],
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await communityService.updateTopic(req.params.id, req.body);
      res.json(result);
    } catch (error) {
      next(error);
    }
  },
);

communityRouter.delete(
  '/community/comments/:id',
  authenticate,
  [param('id').isString(), validateRequest],
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = req.user as AuthUser;
      const result = await communityService.softDeleteComment(req.params.id, user.id);
      res.json(result);
    } catch (error) {
      next(error);
    }
  },
);

// ── Category Management ───────────────────────────────────────
// Note: GET /community/categories already exists above in Categories section
communityRouter.post(
  '/community/categories',
  authenticate,
  requireRole('MODERATOR', 'ADMIN'),
  [
    body('name').isString().isLength({ min: 1 }).withMessage('Name is required'),
    body('description').optional().isString(),
    body('icon').optional().isString(),
    body('order').optional().isInt().toInt(),
    validateRequest,
  ],
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await communityService.createCategory(req.body);
      const moderatorId = (req.user as AuthUser).id;
      await queueReward(moderatorId, 5, 'Category created', 'MODERATOR_ACTION', `mod-category:${result.id}:${moderatorId}`);
      res.status(201).json(result);
    } catch (error) {
      next(error);
    }
  },
);

communityRouter.patch(
  '/community/categories/:id',
  authenticate,
  requireRole('MODERATOR', 'ADMIN'),
  [
    param('id').isString(),
    body('name').optional().isString(),
    body('description').optional().isString(),
    body('icon').optional().isString(),
    body('order').optional().isInt().toInt(),
    validateRequest,
  ],
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await communityService.updateCategory(req.params.id, req.body);
      res.json(result);
    } catch (error) {
      next(error);
    }
  },
);

communityRouter.delete(
  '/community/categories/:id',
  authenticate,
  requireRole('MODERATOR', 'ADMIN'),
  [param('id').isString(), validateRequest],
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await communityService.deleteCategory(req.params.id);
      res.json(result);
    } catch (error) {
      next(error);
    }
  },
);

// ── Topic Shares ──────────────────────────────────────────────
communityRouter.post(
  '/community/topics/:topicId/share',
  authenticate,
  [param('topicId').isString(), validateRequest],
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = req.user as AuthUser;
      const result = await communityService.shareTopic(req.params.topicId, user.id);
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
    body('topicId').isString().notEmpty().withMessage('Topic ID is required'),
    body('voteType').optional().isIn(['UPVOTE', 'DOWNVOTE', 'LIKE']).withMessage('Vote type must be UPVOTE, DOWNVOTE, or LIKE'),
    validateRequest,
  ],
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = req.user as AuthUser;
      const voteType = req.body.voteType === 'LIKE' ? 'UPVOTE' : req.body.voteType || 'UPVOTE';
      const result = await communityService.voteOnTopic(user.id, req.body.topicId, voteType);
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
    body('voteType').optional().isIn(['UPVOTE', 'DOWNVOTE', 'LIKE']).withMessage('Vote type must be UPVOTE, DOWNVOTE, or LIKE'),
    validateRequest,
  ],
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = req.user as AuthUser;
      const voteType = req.body.voteType === 'LIKE' ? 'UPVOTE' : req.body.voteType || 'UPVOTE';
      const result = await communityService.voteOnComment(user.id, req.body.commentId, voteType);
      res.json(result);
    } catch (error) {
      next(error);
    }
  },
);

// ── Leaderboard ────────────────────────────────────────────

// GET /api/community/leaderboard — top 20 contributors by token balance
communityRouter.get(
  '/community/leaderboard',
  [
    query('period').optional().isIn(['all', 'week', 'month']).withMessage('Period must be all, week, or month'),
  ],
  validateRequest,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const period = (req.query.period as string) || 'all';
      const leaderboard = await getLeaderboard(period as 'all' | 'week' | 'month');
      res.json(leaderboard);
    } catch (error) {
      next(error);
    }
  },
);

// GET /api/community/leaderboard/me — authenticated user's rank and token total
communityRouter.get(
  '/community/leaderboard/me',
  authenticate,
  [
    query('period').optional().isIn(['all', 'week', 'month']),
  ],
  validateRequest,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = req.user as AuthUser;
      const period = (req.query.period as string) || 'all';
      const rankInfo = await getUserRank(user.id, period as 'all' | 'week' | 'month');
      res.json(rankInfo);
    } catch (error) {
      next(error);
    }
  },
);
