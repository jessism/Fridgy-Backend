const express = require('express');
const authController = require('../controller/authController');

const router = express.Router();

// Sign up endpoint
router.post('/signup', authController.signup);

// Sign in endpoint
router.post('/signin', authController.signin);

// Get current user endpoint
router.get('/me', authController.getCurrentUser);

// Logout endpoint
router.post('/logout', authController.logout);

module.exports = router; 