import fs from 'fs';
import path from 'path';
import { randomBytes } from 'crypto';
import multer from 'multer';
import { AppError } from './error-handler.js';

const UPLOAD_ROOT = path.join(process.cwd(), 'uploads');
const PRODUCTS_DIR = path.join(UPLOAD_ROOT, 'products');
const RETURNS_DIR = path.join(UPLOAD_ROOT, 'returns');
const AVATARS_DIR = path.join(UPLOAD_ROOT, 'avatars');
const MARKETING_DIR = path.join(UPLOAD_ROOT, 'marketing');
const REVIEWS_DIR = path.join(UPLOAD_ROOT, 'reviews');
export const SHIPPING_LABELS_DIR = path.join(UPLOAD_ROOT, 'shipping-labels');

export function ensureUploadDirs() {
  fs.mkdirSync(PRODUCTS_DIR, { recursive: true });
  fs.mkdirSync(RETURNS_DIR, { recursive: true });
  fs.mkdirSync(AVATARS_DIR, { recursive: true });
  fs.mkdirSync(MARKETING_DIR, { recursive: true });
  fs.mkdirSync(REVIEWS_DIR, { recursive: true });
  fs.mkdirSync(SHIPPING_LABELS_DIR, { recursive: true });
}

function fileFilter(_req, file, cb) {
  const ok = /^image\/(jpeg|png|webp)$/i.test(file.mimetype);
  const ext = path.extname(file.originalname || '').toLowerCase();
  const extOk = ['.jpg', '.jpeg', '.png', '.webp'].includes(ext);
  if (ok && extOk) cb(null, true);
  else cb(new Error('Only JPEG, PNG, or WebP images are allowed'));
}

/** Reject files whose magic bytes do not match an allowed image type. */
export function assertImageMagicBytes(filePath) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.alloc(12);
    const n = fs.readSync(fd, buf, 0, 12, 0);
    if (n < 3) throw new AppError(400, 'Invalid image file');
    const isJpeg = buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
    const isPng =
      buf[0] === 0x89 &&
      buf[1] === 0x50 &&
      buf[2] === 0x4e &&
      buf[3] === 0x47;
    const isWebp =
      buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP';
    if (!isJpeg && !isPng && !isWebp) {
      throw new AppError(400, 'File content is not a valid JPEG, PNG, or WebP image');
    }
  } finally {
    fs.closeSync(fd);
  }
}

/** Verify magic bytes for a multer file; delete the temp file on failure. */
export function verifyUploadedImage(file) {
  if (!file?.path) {
    throw new AppError(400, 'No image file received');
  }
  try {
    assertImageMagicBytes(file.path);
  } catch (err) {
    try {
      fs.unlinkSync(file.path);
    } catch {
      /* ignore */
    }
    throw err instanceof AppError ? err : new AppError(400, 'Invalid image file');
  }
}

/** Default product / return / avatar limit. */
export const IMAGE_UPLOAD_MAX_BYTES = 5 * 1024 * 1024;
/** Hero / letter / marketing carousel images (often larger lifestyle photos). */
export const MARKETING_IMAGE_UPLOAD_MAX_BYTES = 20 * 1024 * 1024;

function createImageUpload(destinationDir, maxBytes = IMAGE_UPLOAD_MAX_BYTES) {
  const storage = multer.diskStorage({
    destination(_req, _file, cb) {
      ensureUploadDirs();
      cb(null, destinationDir);
    },
    filename(_req, file, cb) {
      const ext = path.extname(file.originalname || '').toLowerCase();
      const safeExt = ['.jpg', '.jpeg', '.png', '.webp'].includes(ext) ? ext : '.jpg';
      const name = `${Date.now()}-${randomBytes(8).toString('hex')}${safeExt}`;
      cb(null, name);
    },
  });

  return multer({
    storage,
    limits: { fileSize: maxBytes },
    fileFilter,
  });
}

const storage = multer.diskStorage({
  destination(_req, _file, cb) {
    ensureUploadDirs();
    cb(null, PRODUCTS_DIR);
  },
  filename(_req, file, cb) {
    const ext = path.extname(file.originalname || '').toLowerCase();
    const safeExt = ['.jpg', '.jpeg', '.png', '.webp'].includes(ext) ? ext : '.jpg';
    const name = `${Date.now()}-${randomBytes(8).toString('hex')}${safeExt}`;
    cb(null, name);
  },
});

export const productImageUpload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter,
});

export const returnPhotoUpload = createImageUpload(RETURNS_DIR);

export const reviewImageUpload = createImageUpload(REVIEWS_DIR);

export const avatarImageUpload = createImageUpload(AVATARS_DIR);

export const marketingImageUpload = createImageUpload(MARKETING_DIR, MARKETING_IMAGE_UPLOAD_MAX_BYTES);

export { UPLOAD_ROOT, PRODUCTS_DIR, RETURNS_DIR, AVATARS_DIR, MARKETING_DIR, REVIEWS_DIR };
