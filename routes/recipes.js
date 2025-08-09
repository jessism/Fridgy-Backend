const express = require('express');
const recipeController = require('../controller/recipeController');
const authMiddleware = require('../middleware/auth');

const router = express.Router();

/**
 * Recipe Routes
 * All routes require authentication via JWT token
 */

// Health check endpoint (no auth required for monitoring)
router.get('/health', recipeController.healthCheck);

// Get recipe suggestions based on user's inventory
// GET /api/recipes/suggestions
router.get('/suggestions', authMiddleware.authenticateToken, recipeController.getSuggestions);

// Get detailed recipe information
// GET /api/recipes/:id
router.get('/:id', authMiddleware.authenticateToken, recipeController.getRecipeDetails);

// Mark ingredients as used when cooking a recipe
// POST /api/recipes/:id/cook
router.post('/:id/cook', authMiddleware.authenticateToken, recipeController.markRecipeCooked);

module.exports = router;