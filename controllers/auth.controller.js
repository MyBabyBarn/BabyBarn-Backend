import { authService } from '../services/auth.service.js';
import { validate } from '../utils/validation.js';
import {
  registerSchema,
  loginSchema,
  refreshTokenSchema,
  resetPasswordSchema,
  confirmPasswordSchema,
  verifyEmailSchema,
  updateProfileSchema,
  changePasswordSchema,
  changeEmailSchema,
  pauseAccountSchema,
  addressCreateSchema,
  addressUpdateSchema,
} from '../schemas/index.js';
import { verifyToken } from '../utils/jwt.js';
import { verifyUploadedImage } from '../utils/product-upload.js';

export class AuthController {
  async register(req, res) {
    const data = await validate(registerSchema, req.body);
    const result = await authService.register(
      data.email,
      data.password,
      data.firstName,
      data.lastName
    );

    res.status(201).json({
      success: true,
      message: 'User registered successfully',
      data: result,
    });
  }

  async login(req, res) {
    const data = await validate(loginSchema, req.body);
    const result = await authService.login(data.email, data.password, data.portal);

    res.status(200).json({
      success: true,
      message: 'Login successful',
      data: result,
    });
  }

  async refreshToken(req, res) {
    const data = await validate(refreshTokenSchema, req.body);
    const result = await authService.refreshAccessToken(data.refreshToken);
    res.status(200).json({
      success: true,
      message: 'Token refreshed',
      data: result,
    });
  }

  async getProfile(req, res) {
    const user = await authService.getUserById(req.user.id);

    res.status(200).json({
      success: true,
      data: user,
    });
  }

  async forgotPassword(req, res) {
    const data = await validate(resetPasswordSchema, req.body);
    const result = await authService.forgotPassword(data.email, data.portal);

    res.status(200).json({
      success: true,
      message: result.message,
      data: result,
    });
  }

  async resetPasswordWithToken(req, res) {
    const data = await validate(confirmPasswordSchema, req.body);
    const result = await authService.resetPassword(data.token, data.password);

    res.status(200).json({
      success: true,
      message: result.message,
      data: result,
    });
  }

  async verifyEmail(req, res) {
    const data = await validate(verifyEmailSchema, req.query);
    const result = await authService.verifyEmail(data.token);

    res.status(200).json({
      success: true,
      message: result.message,
      data: result,
    });
  }

  async resendVerification(req, res) {
    const data = await validate(resetPasswordSchema, req.body);
    const result = await authService.resendVerification(data.email);

    res.status(200).json({
      success: true,
      message: result.message,
      data: result,
    });
  }

  async updateProfile(req, res) {
    const data = await validate(updateProfileSchema, req.body);
    const result = await authService.updateProfile(req.user.id, data);
    res.status(200).json({ success: true, message: 'Profile updated', data: result });
  }

  async uploadAvatar(req, res) {
    const file = req.file;
    if (!file) {
      return res.status(400).json({
        success: false,
        message: 'No image file received (use field name "image").',
      });
    }
    verifyUploadedImage(file);
    const relative = `/uploads/avatars/${file.filename}`;
    const result = await authService.updateProfile(req.user.id, { avatarUrl: relative });
    res.status(201).json({
      success: true,
      message: 'Photo updated',
      data: { url: relative, user: result },
    });
  }

  async changePassword(req, res) {
    const data = await validate(changePasswordSchema, req.body);
    const result = await authService.changePassword(req.user.id, data.currentPassword, data.newPassword);
    res.status(200).json({ success: true, message: result.message, data: result });
  }

  async verifyPassword(req, res) {
    const currentPassword = typeof req.body?.currentPassword === 'string' ? req.body.currentPassword : '';
    const result = await authService.verifyCurrentPassword(req.user.id, currentPassword);
    res.status(200).json({ success: true, data: result });
  }

  async changeEmail(req, res) {
    const data = await validate(changeEmailSchema, req.body);
    const result = await authService.changeEmail(req.user.id, data.newEmail, data.currentPassword);
    res.status(200).json({ success: true, message: result.message, data: result });
  }

  async pauseAccount(req, res) {
    const data = await validate(pauseAccountSchema, req.body);
    const result = await authService.pauseAccount(req.user.id, data.currentPassword);
    res.status(200).json({ success: true, message: result.message, data: result });
  }

  async logout(req, res) {
    const refreshToken =
      typeof req.body?.refreshToken === 'string' ? req.body.refreshToken : null;

    // Prefer refresh-token revoke so logout works when the access JWT already expired.
    if (refreshToken) {
      const result = await authService.logoutByRefreshToken(refreshToken);
      res.status(200).json({ success: true, message: result.message, data: result });
      return;
    }

    const bearer = req.headers.authorization?.split(' ')[1];
    if (bearer) {
      try {
        const decoded = verifyToken(bearer);
        if (decoded?.id) {
          const result = await authService.logout(decoded.id, null);
          res.status(200).json({ success: true, message: result.message, data: result });
          return;
        }
      } catch {
        // Expired/invalid access token — still report signed out locally.
      }
    }

    res.status(200).json({ success: true, message: 'Signed out', data: { message: 'Signed out' } });
  }

  async logoutOtherSessions(req, res) {
    const result = await authService.logoutOtherSessions(req.user.id);
    res.status(200).json({ success: true, message: result.message, data: result });
  }

  async listAddresses(req, res) {
    const items = await authService.listAddresses(req.user.id);
    res.status(200).json({ success: true, data: items });
  }

  async createAddress(req, res) {
    const data = await validate(addressCreateSchema, req.body);
    const result = await authService.createAddress(req.user.id, data);
    res.status(201).json({ success: true, message: 'Address created', data: result });
  }

  async updateAddress(req, res) {
    const data = await validate(addressUpdateSchema, req.body);
    const result = await authService.updateAddress(req.user.id, req.params.addressId, data);
    res.status(200).json({ success: true, message: result.message, data: result });
  }

  async deleteAddress(req, res) {
    const result = await authService.deleteAddress(req.user.id, req.params.addressId);
    res.status(200).json({ success: true, message: result.message, data: result });
  }
}

export const authController = new AuthController();
