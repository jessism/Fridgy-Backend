const express = require('express');
const userPreferencesController = require('../controller/userPreferencesController');
const authMiddleware = require('../middleware/auth');

const router = express.Router();

/**
 * User Preferences Routes
 * All routes require authentication via JWT token
 */

// Health check endpoint (no auth required for monitoring)
router.get('/health', userPreferencesController.healthCheck);

// Get user's dietary preferences
// GET /api/user-preferences
router.get('/', authMiddleware.authenticateToken, userPreferencesController.getPreferences);

// Save or update user's dietary preferences
// POST /api/user-preferences
router.post('/', authMiddleware.authenticateToken, userPreferencesController.savePreferences);

// Delete user's dietary preferences
// DELETE /api/user-preferences
router.delete('/', authMiddleware.authenticateToken, userPreferencesController.deletePreferences);

module.exports = router;