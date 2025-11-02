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

// Mark welcome tour as completed
router.patch('/welcome-tour/complete', authenticateToken, authController.markWelcomeTourComplete);

module.exports = router; 