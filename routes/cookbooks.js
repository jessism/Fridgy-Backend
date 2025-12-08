const express = require('express');
const router = express.Router();
const cookbooksController = require('../controller/cookbooksController');
const authMiddleware = require('../middleware/auth');

/**
 * Cookbooks Routes
 * All routes (except health) require authentication via JWT token
 */

// Health check (no auth required)
router.get('/health', cookbooksController.healthCheck);

// Get all cookbooks for authenticated user
router.get('/', authMiddleware.authenticateToken, cookbooksController.getCookbooks);

// Get specific cookbook by ID with recipes
router.get('/:id', authMiddleware.authenticateToken, cookbooksController.getCookbookById);

// Create new cookbook
router.post('/', authMiddleware.authenticateToken, cookbooksController.createCookbook);

// Update cookbook
router.put('/:id', authMiddleware.authenticateToken, cookbooksController.updateCookbook);

// Delete cookbook
router.delete('/:id', authMiddleware.authenticateToken, cookbooksController.deleteCookbook);

// Add recipes to cookbook
router.post('/:id/recipes', authMiddleware.authenticateToken, cookbooksController.addRecipes);

// Remove recipe from cookbook
router.delete('/:id/recipes/:recipeId', authMiddleware.authenticateToken, cookbooksController.removeRecipe);

// ============================================
// Sharing Routes
// ============================================

// Generate/get share code for a cookbook (owner only)
router.post('/:id/share', authMiddleware.authenticateToken, cookbooksController.generateShareCode);

// Join a cookbook via share code
router.get('/join/:shareCode', authMiddleware.authenticateToken, cookbooksController.joinCookbook);

// Get members of a cookbook
router.get('/:id/members', authMiddleware.authenticateToken, cookbooksController.getMembers);

// Remove a member from cookbook (owner only, or self-removal)
router.delete('/:id/members/:memberId', authMiddleware.authenticateToken, cookbooksController.removeMember);

// Leave a cookbook (self-removal for non-owners)
router.post('/:id/leave', authMiddleware.authenticateToken, cookbooksController.leaveCookbook);

module.exports = router;
