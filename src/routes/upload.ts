import { Router, type Request, type Response } from 'express';
import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { authenticate } from '../middleware/auth';
import { upload, uploadAudio } from '../middleware/upload';
import { prisma } from '../lib/prisma';

export const uploadRouter = Router();

type UploadKind = 'IMAGE' | 'AUDIO';

const persistUploadedFile = async (file: Express.Multer.File, kind: UploadKind): Promise<void> => {
  if (!file.path) {
    throw new Error('Uploaded file path is missing');
  }

  const data = await fs.readFile(file.path);
  const checksum = crypto.createHash('sha256').update(data).digest('hex');
  const extension = path.extname(file.originalname).toLowerCase();
  const mimeType = file.mimetype || (extension === '.svg' ? 'image/svg+xml' : 'application/octet-stream');

  await prisma.uploadedFile.upsert({
    where: { filename: file.filename },
    create: {
      filename: file.filename,
      mimeType,
      size: file.size,
      kind,
      data,
      checksum,
    },
    update: {
      mimeType,
      size: file.size,
      kind,
      data,
      checksum,
    },
  });

  await fs.unlink(file.path).catch(() => undefined);
};

const handleUpload = (kind: UploadKind) => async (req: Request, res: Response): Promise<void> => {
  const middleware = kind === 'IMAGE' ? upload.single('file') : uploadAudio.single('file');

  middleware(req, res, async (err) => {
    if (err) {
      const message = err instanceof Error ? err.message : 'Upload failed';
      res.status(400).json({ error: message });
      return;
    }

    if (!req.file) {
      res.status(400).json({ error: 'No file provided' });
      return;
    }

    try {
      await persistUploadedFile(req.file, kind);
    } catch (error) {
      if (req.file.path) {
        await fs.unlink(req.file.path).catch(() => undefined);
      }
      res.status(500).json({ error: 'Unable to store uploaded file' });
      return;
    }

    const relativePath = `/uploads/${req.file.filename}`;
    if (kind === 'IMAGE') {
      res.status(201).json({ url: relativePath });
      return;
    }

    res.status(201).json({
      url: relativePath,
      mimeType: req.file.mimetype,
      size: req.file.size,
    });
  });
};

uploadRouter.post('/upload', authenticate, handleUpload('IMAGE'));
uploadRouter.post('/upload/audio', authenticate, handleUpload('AUDIO'));
