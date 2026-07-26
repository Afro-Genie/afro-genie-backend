import { Router, type Request, type Response } from 'express';
import path from 'path';
import { authenticate } from '../middleware/auth';
import { upload } from '../middleware/upload';

export const uploadRouter = Router();

/**
 * POST /api/upload
 * Accepts a single file under the field name "file".
 * Requires authentication.
 * Returns { url: string } — the public path to the uploaded file.
 */
uploadRouter.post(
  '/upload',
  authenticate,
  (req: Request, res: Response) => {
    upload.single('file')(req, res, (err) => {
      if (err) {
        const message = err instanceof Error ? err.message : 'Upload failed';
        res.status(400).json({ error: message });
        return;
      }

      if (!req.file) {
        res.status(400).json({ error: 'No file provided' });
        return;
      }

      const relativePath = `/uploads/${req.file.filename}`;
      res.status(201).json({ url: relativePath });
    });
  },
);
