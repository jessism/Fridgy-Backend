const express = require('express');
const recipeController = require('../controller/recipeController');
const authMiddleware = require('../middleware/auth');
const edamamService = require('../services/edamamService');
const recipeService = require('../services/recipeService');

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

// Simple Edamam connection test
// GET /api/recipes/edamam-test/check
router.get('/edamam-test/check', async (req, res) => {
  console.log('\n🔬 Testing Edamam connection...');
  
  try {
    // Test with a simple query
    const testRecipes = await edamamService.searchRecipesByIngredients(
      ['chicken', 'rice'],
      { number: 2 }
    );
    
    res.json({
      success: true,
      message: 'Edamam API connection successful',
      recipesFound: testRecipes.length,
      credentials: {
        appIdSet: !!process.env.EDAMAM_APP_ID,
        appKeySet: !!process.env.EDAMAM_APP_KEY
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
      credentials: {
        appIdSet: !!process.env.EDAMAM_APP_ID,
        appKeySet: !!process.env.EDAMAM_APP_KEY,
        appIdValue: process.env.EDAMAM_APP_ID
      }
    });
  }
});

// Edamam test route for side-by-side comparison
// GET /api/recipes/edamam-test/suggestions
// IMPORTANT: This must come BEFORE the /:id route to avoid being caught by the ID parameter
router.get('/edamam-test/suggestions', authMiddleware.authenticateToken, async (req, res) => {
  const requestId = Math.random().toString(36).substring(7);
  
  try {
    console.log(`\n🧪 Edamam test request: ${requestId}`);
    
    // Get user ID from JWT token
    const userId = req.user?.userId || req.user?.id;
    console.log(`🧪 User ID: ${userId}`);
    
    // Check if Edamam is configured
    if (!process.env.EDAMAM_APP_ID || !process.env.EDAMAM_APP_KEY) {
      throw new Error('Edamam API credentials not configured');
    }
    
    // Get user's inventory
    const inventory = await recipeService.getUserInventory(userId);
    
    if (inventory.length === 0) {
      console.log(`⚠️ No inventory items found for user`);
      return res.json({
        success: true,
        suggestions: [],
        source: 'edamam',
        message: 'No inventory items to search with'
      });
    }
    
    // Prioritize ingredients
    const prioritizedIngredients = recipeService.prioritizeIngredients(inventory);
    const ingredientNames = prioritizedIngredients.map(item => item.item_name);
    
    console.log(`🧪 Searching Edamam with: ${ingredientNames.join(', ')}`);
    
    // Get recipes from Edamam
    const edamamRecipes = await edamamService.searchRecipesByIngredients(
      ingredientNames,
      { number: parseInt(req.query.limit) || 8 }
    );
    
    console.log(`🧪 Found ${edamamRecipes.length} Edamam recipes`);
    
    res.json({
      success: true,
      suggestions: edamamRecipes,
      source: 'edamam',
      count: edamamRecipes.length
    });
    
  } catch (error) {
    console.error(`💥 Edamam test error:`, error);
    res.status(500).json({
      success: false,
      error: error.message,
      source: 'edamam'
    });
  }
});

// Tasty test route for side-by-side comparison
// GET /api/recipes/tasty-test/check
router.get('/tasty-test/check', async (req, res) => {
  console.log('\n🍳 Testing Tasty connection...');
  
  try {
    // Check if API key is configured
    const apiKeySet = !!process.env.RAPIDAPI_KEY;
    
    if (!apiKeySet) {
      return res.json({
        success: false,
        message: 'Tasty API key not configured',
        credentials: {
          apiKeySet: false
        }
      });
    }
    
    res.json({
      success: true,
      message: 'Tasty API configured',
      credentials: {
        apiKeySet: true
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
      credentials: {
        apiKeySet: !!process.env.RAPIDAPI_KEY
      }
    });
  }
});

// Tasty recipes based on inventory
// GET /api/recipes/tasty-test/suggestions
router.get('/tasty-test/suggestions', authMiddleware.authenticateToken, async (req, res) => {
  const requestId = Math.random().toString(36).substring(7);
  
  try {
    console.log(`\n🍳 Tasty test request: ${requestId}`);
    
    // Get user ID from JWT token
    const userId = req.user?.userId || req.user?.id;
    console.log(`🍳 User ID: ${userId}`);
    
    // Check if Tasty is configured
    if (!process.env.RAPIDAPI_KEY) {
      throw new Error('Tasty API key not configured');
    }
    
    // Get user's inventory
    const inventory = await recipeService.getUserInventory(userId);
    
    if (inventory.length === 0) {
      console.log(`⚠️ No inventory items found for user`);
      return res.json({
        success: true,
        suggestions: [],
        source: 'tasty',
        message: 'No inventory items to search with'
      });
    }
    
    // Prioritize ingredients
    const prioritizedIngredients = recipeService.prioritizeIngredients(inventory);
    const ingredientNames = prioritizedIngredients.map(item => item.item_name);
    
    console.log(`🍳 Searching Tasty with: ${ingredientNames.slice(0, 5).join(', ')}`);
    
    // Import Tasty service
    const tastyService = require('../services/tastyService');
    
    // Get recipes from Tasty
    const tastyRecipes = await tastyService.searchRecipesByIngredients(
      ingredientNames,
      { number: parseInt(req.query.limit) || 8 }
    );
    
    console.log(`🍳 Found ${tastyRecipes.length} Tasty recipes`);
    
    res.json({
      success: true,
      suggestions: tastyRecipes,
      source: 'tasty',
      count: tastyRecipes.length
    });
    
  } catch (error) {
    console.error(`💥 Tasty test error:`, error);
    res.status(500).json({
      success: false,
      error: error.message,
      source: 'tasty'
    });
  }
});

// Get detailed recipe information
// GET /api/recipes/:id
// NOTE: This generic route must come AFTER all specific routes
router.get('/:id', authMiddleware.authenticateToken, recipeController.getRecipeDetails);

// Mark ingredients as used when cooking a recipe
// POST /api/recipes/:id/cook
router.post('/:id/cook', authMiddleware.authenticateToken, recipeController.markRecipeCooked);

module.exports = router;