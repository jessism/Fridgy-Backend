const express = require('express');
const aiRecipeController = require('../controller/aiRecipeController');
const authMiddleware = require('../middleware/auth');
const { checkAIRecipeLimit } = require('../middleware/checkLimits');

const router = express.Router();

/**
 * AI Recipe Generation Routes
 * All routes require authentication via JWT token
 */

// Health check endpoint (no auth required for monitoring)
router.get('/health', aiRecipeController.healthCheck);

// Generate AI recipes based on user's inventory and preferences
// POST /api/ai-recipes/generate (FREE: 3/month, PREMIUM: unlimited)
router.post('/generate', authMiddleware.authenticateToken, checkAIRecipeLimit, aiRecipeController.generateRecipes);

// Get cached recipes for faster loading
// GET /api/ai-recipes/cached
router.get('/cached', authMiddleware.authenticateToken, aiRecipeController.getCachedRecipes);

// Get past AI recipe generations (history)
// GET /api/ai-recipes/history?limit=10
router.get('/history', authMiddleware.authenticateToken, aiRecipeController.getHistory);

// Delete a specific AI recipe generation
// DELETE /api/ai-recipes/:generationId
router.delete('/:generationId', authMiddleware.authenticateToken, aiRecipeController.deleteGeneration);

// Clear user's recipe cache (force regeneration)
// DELETE /api/ai-recipes/cache
router.delete('/cache', authMiddleware.authenticateToken, aiRecipeController.clearCache);

// Get AI recipe generation analytics for the user
// GET /api/ai-recipes/analytics
router.get('/analytics', authMiddleware.authenticateToken, aiRecipeController.getAnalytics);

module.exports = router;