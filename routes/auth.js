const express = require('express');
const authController = require('../controller/authController');
const { authenticateToken } = require('../middleware/auth');

const router = express.Router();

// Sign up endpoint
router.post('/signup', authController.signup);

// Sign in endpoint
router.post('/signin', authController.signin);

// Get current user endpoint - NOW WITH AUTH MIDDLEWARE!
router.get('/me', authenticateToken, authController.getCurrentUser);

// Refresh token endpoint
router.post('/refresh', authController.refreshToken);

// Logout endpoint
router.post('/logout', authController.logout);

// Debug endpoint (remove in production)
router.get('/debug', (req, res) => {
  const getCookieOptions = (isPWA = false) => {
    const isProduction = process.env.NODE_ENV === 'production';
    const maxAge = isPWA ? 30 * 24 * 60 * 60 * 1000 : 7 * 24 * 60 * 60 * 1000;

    return {
      httpOnly: true,
      secure: isProduction,
      sameSite: 'lax',
      domain: isProduction ? '.trackabite.app' : undefined,
      maxAge,
      path: '/'
    };
  };

  res.json({
    nodeEnv: process.env.NODE_ENV,
    isProduction: process.env.NODE_ENV === 'production',
    cookieOptions: getCookieOptions(true),
    headers: {
      host: req.headers.host,
      origin: req.headers.origin,
      cookie: req.headers.cookie ? 'cookies present' : 'no cookies',
      userAgent: req.headers['user-agent']
    },
    cookies: req.cookies ? Object.keys(req.cookies) : []
  });
});

module.exports = router; 