import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { randomUUID } from 'crypto';
import logger from '../utils/logger.js';

const UPLOAD_DIR = '/tmp/uploads';

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

export async function cleanupUploadedFiles(
  files: Express.Multer.File[] | undefined,
): Promise<void> {
  if (!files?.length) return;

  await Promise.all(
    files.map(async (file) => {
      try {
        await fs.promises.unlink(file.path);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
          logger.warn('Failed to clean up uploaded file', {
            err,
            path: file.path,
          });
        }
      }
    }),
  );
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${randomUUID()}${ext}`);
  },
});

export const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/webp'];
    cb(null, allowed.includes(file.mimetype));
  },
});
