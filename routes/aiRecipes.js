const express = require('express');
const aiRecipeController = require('../controller/aiRecipeController');
const authMiddleware = require('../middleware/auth');
const { requirePremium } = require('../middleware/checkLimits');

const router = express.Router();

/**
 * AI Recipe Generation Routes
 * All routes require authentication via JWT token
 */

// Health check endpoint (no auth required for monitoring)
router.get('/health', aiRecipeController.healthCheck);

// Generate AI recipes based on user's inventory and preferences
// POST /api/ai-recipes/generate (PREMIUM ONLY)
router.post('/generate', authMiddleware.authenticateToken, requirePremium, aiRecipeController.generateRecipes);

// Get cached recipes for faster loading
// GET /api/ai-recipes/cached
router.get('/cached', authMiddleware.authenticateToken, aiRecipeController.getCachedRecipes);

// Clear user's recipe cache (force regeneration)
// DELETE /api/ai-recipes/cache
router.delete('/cache', authMiddleware.authenticateToken, aiRecipeController.clearCache);

// Get AI recipe generation analytics for the user
// GET /api/ai-recipes/analytics
router.get('/analytics', authMiddleware.authenticateToken, aiRecipeController.getAnalytics);

module.exports = router;