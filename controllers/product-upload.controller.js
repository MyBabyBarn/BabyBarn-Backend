import { config } from '../config/env.js';
import { verifyUploadedImage } from '../utils/product-upload.js';

export class ProductUploadController {
  resolvePublicBaseUrl(req) {
    if (config.publicBaseUrl) return config.publicBaseUrl;
    const forwardedProto = req.get('x-forwarded-proto')?.split(',')[0]?.trim();
    const forwardedHost = req.get('x-forwarded-host')?.split(',')[0]?.trim();
    const protocol = forwardedProto || req.protocol;
    const host = forwardedHost || req.get('host');
    return `${protocol}://${host}`.replace(/\/$/, '');
  }

  /**
   * POST multipart field name: `image` (single file).
   * Returns absolute public URL for use in `imageUrl` / `gallery`.
   */
  uploadProductImage(req, res) {
    const file = req.file;
    if (!file) {
      return res.status(400).json({
        success: false,
        message: 'No image file received (use field name "image").',
      });
    }
    verifyUploadedImage(file);

    const relative = `/uploads/products/${file.filename}`;
    const url = `${this.resolvePublicBaseUrl(req)}${relative}`;

    res.status(201).json({
      success: true,
      data: { url, path: relative },
    });
  }
}

export const productUploadController = new ProductUploadController();
