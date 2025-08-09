const jwt = require('jsonwebtoken');
const recipeService = require('../services/recipeService');

// JWT secret
const JWT_SECRET = process.env.JWT_SECRET || 'your-super-secret-jwt-key-change-in-production';

// Helper function to get user ID from token
const getUserIdFromToken = (req) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  
  if (!token) {
    throw new Error('No token provided');
  }
  
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    return decoded.userId;
  } catch (error) {
    throw new Error('Invalid token');
  }
};

// Recipe Controller Functions
const recipeController = {
  
  /**
   * Get recipe suggestions based on user's inventory
   * GET /api/recipes/suggestions
   */
  async getSuggestions(req, res) {
    const requestId = Math.random().toString(36).substring(7);
    
    try {
      console.log(`\n🍽️  ================ GET RECIPE SUGGESTIONS START ================`);
      console.log(`🍽️  REQUEST ID: ${requestId}`);
      console.log(`🍽️  Fetching recipe suggestions for authenticated user...`);
      
      // Get user ID from JWT token
      const userId = getUserIdFromToken(req);
      console.log(`🍽️  [${requestId}] User ID: ${userId}`);
      
      // Parse query parameters
      const {
        limit = 12,
        ranking = 1, // 1 = maximize used ingredients, 2 = minimize missing ingredients
        minMatch = 0 // Minimum match percentage filter
      } = req.query;
      
      console.log(`🔧 [${requestId}] Options: limit=${limit}, ranking=${ranking}, minMatch=${minMatch}`);
      
      // Get recipe suggestions from service
      const suggestions = await recipeService.getRecipeSuggestions(userId, {
        number: parseInt(limit),
        ranking: parseInt(ranking)
      });
      
      // Apply minimum match filter if specified
      const filteredSuggestions = suggestions.filter(recipe => 
        recipe.matchPercentage >= parseInt(minMatch)
      );
      
      console.log(`📊 [${requestId}] Returning ${filteredSuggestions.length} suggestions (after filters)`);
      
      res.json({
        success: true,
        suggestions: filteredSuggestions,
        count: filteredSuggestions.length,
        requestId: requestId,
        meta: {
          totalFound: suggestions.length,
          filtered: suggestions.length - filteredSuggestions.length,
          minMatch: parseInt(minMatch)
        }
      });
      
      console.log(`\n✅ [${requestId}] ============= GET RECIPE SUGGESTIONS COMPLETE =============\n`);
      
    } catch (error) {
      console.error(`\n💥 [${requestId}] ========== GET RECIPE SUGGESTIONS ERROR ==========`);
      console.error(`💥 [${requestId}] Error:`, error);
      console.error(`💥 [${requestId}] Error message:`, error.message);
      console.error(`💥 [${requestId}] ===================================================\n`);
      
      const statusCode = error.message.includes('token') ? 401 : 
                        error.message.includes('API key') ? 503 : 500;
      
      res.status(statusCode).json({
        success: false,
        error: error.message.includes('token') ? 'Authentication required' :
               error.message.includes('API key') ? 'Recipe service temporarily unavailable' :
               'Failed to fetch recipe suggestions',
        requestId: requestId,
        details: process.env.NODE_ENV === 'development' ? error.message : undefined
      });
    }
  },

  /**
   * Get detailed recipe information
   * GET /api/recipes/:id
   */
  async getRecipeDetails(req, res) {
    const requestId = Math.random().toString(36).substring(7);
    
    try {
      console.log(`\n📖 ================ GET RECIPE DETAILS START ================`);
      console.log(`📖 REQUEST ID: ${requestId}`);
      
      const { id } = req.params;
      
      // Verify user is authenticated
      const userId = getUserIdFromToken(req);
      console.log(`📖 [${requestId}] User ID: ${userId}, Recipe ID: ${id}`);
      
      if (!id || isNaN(parseInt(id))) {
        throw new Error('Invalid recipe ID');
      }
      
      // Get recipe details from service
      const recipeDetails = await recipeService.getRecipeDetails(parseInt(id));
      
      console.log(`📖 [${requestId}] Retrieved details for: ${recipeDetails.title}`);
      
      // Format response with additional fields
      const formattedRecipe = {
        id: recipeDetails.id,
        title: recipeDetails.title,
        image: recipeDetails.image,
        readyInMinutes: recipeDetails.readyInMinutes,
        servings: recipeDetails.servings,
        healthScore: recipeDetails.healthScore,
        pricePerServing: recipeDetails.pricePerServing ? Math.round(recipeDetails.pricePerServing) : null,
        sourceName: recipeDetails.sourceName,
        sourceUrl: recipeDetails.sourceUrl,
        summary: recipeDetails.summary,
        instructions: recipeDetails.instructions,
        extendedIngredients: recipeDetails.extendedIngredients?.map(ing => ({
          id: ing.id,
          name: ing.name,
          original: ing.original,
          amount: ing.amount,
          unit: ing.unit,
          image: ing.image
        })) || [],
        dishTypes: recipeDetails.dishTypes || [],
        cuisines: recipeDetails.cuisines || [],
        diets: recipeDetails.diets || [],
        occasions: recipeDetails.occasions || [],
        winePairing: recipeDetails.winePairing || null,
        dairyFree: recipeDetails.dairyFree,
        glutenFree: recipeDetails.glutenFree,
        vegetarian: recipeDetails.vegetarian,
        vegan: recipeDetails.vegan
      };
      
      res.json({
        success: true,
        recipe: formattedRecipe,
        requestId: requestId
      });
      
      console.log(`\n✅ [${requestId}] ============= GET RECIPE DETAILS COMPLETE =============\n`);
      
    } catch (error) {
      console.error(`\n💥 [${requestId}] ========== GET RECIPE DETAILS ERROR ==========`);
      console.error(`💥 [${requestId}] Error:`, error);
      console.error(`💥 [${requestId}] ==============================================\n`);
      
      const statusCode = error.message.includes('token') ? 401 :
                        error.message.includes('Invalid recipe ID') ? 400 :
                        error.message.includes('API key') ? 503 : 500;
      
      res.status(statusCode).json({
        success: false,
        error: error.message.includes('token') ? 'Authentication required' :
               error.message.includes('Invalid recipe ID') ? 'Invalid recipe ID' :
               error.message.includes('API key') ? 'Recipe service temporarily unavailable' :
               'Failed to fetch recipe details',
        requestId: requestId,
        details: process.env.NODE_ENV === 'development' ? error.message : undefined
      });
    }
  },

  /**
   * Mark ingredients as used when cooking a recipe
   * POST /api/recipes/:id/cook
   */
  async markRecipeCooked(req, res) {
    const requestId = Math.random().toString(36).substring(7);
    
    try {
      console.log(`\n👨‍🍳 ================ MARK RECIPE COOKED START ================`);
      console.log(`👨‍🍳 REQUEST ID: ${requestId}`);
      
      const { id } = req.params;
      const { usedIngredients = [] } = req.body;
      
      // Get user ID from JWT token
      const userId = getUserIdFromToken(req);
      console.log(`👨‍🍳 [${requestId}] User ID: ${userId}, Recipe ID: ${id}`);
      
      if (!id || isNaN(parseInt(id))) {
        throw new Error('Invalid recipe ID');
      }
      
      if (!Array.isArray(usedIngredients)) {
        throw new Error('usedIngredients must be an array');
      }
      
      console.log(`👨‍🍳 [${requestId}] Marking ${usedIngredients.length} ingredients as used`);
      
      // TODO: Implement inventory update logic
      // This would decrease quantities of used ingredients in the fridge_items table
      // For now, we'll just return success
      
      console.log(`⚠️  [${requestId}] Ingredient usage tracking not yet implemented`);
      
      res.json({
        success: true,
        message: 'Recipe marked as cooked successfully',
        requestId: requestId,
        cookedRecipeId: parseInt(id),
        ingredientsUsed: usedIngredients.length,
        note: 'Ingredient quantity updates not yet implemented'
      });
      
      console.log(`\n✅ [${requestId}] ============= MARK RECIPE COOKED COMPLETE =============\n`);
      
    } catch (error) {
      console.error(`\n💥 [${requestId}] ========== MARK RECIPE COOKED ERROR ==========`);
      console.error(`💥 [${requestId}] Error:`, error);
      console.error(`💥 [${requestId}] =============================================\n`);
      
      const statusCode = error.message.includes('token') ? 401 :
                        error.message.includes('Invalid') ? 400 : 500;
      
      res.status(statusCode).json({
        success: false,
        error: error.message.includes('token') ? 'Authentication required' : error.message,
        requestId: requestId
      });
    }
  },

  /**
   * Health check endpoint for recipe service
   * GET /api/recipes/health
   */
  async healthCheck(req, res) {
    const requestId = Math.random().toString(36).substring(7);
    
    try {
      const hasApiKey = !!process.env.SPOONACULAR_API_KEY && 
                       process.env.SPOONACULAR_API_KEY !== 'your-api-key-here';
      
      res.json({
        success: true,
        service: 'Recipe Service',
        status: hasApiKey ? 'ready' : 'configuration_required',
        apiKeyConfigured: hasApiKey,
        requestId: requestId,
        timestamp: new Date().toISOString()
      });
      
    } catch (error) {
      res.status(500).json({
        success: false,
        service: 'Recipe Service',
        status: 'error',
        error: error.message,
        requestId: requestId
      });
    }
  }
};

module.exports = recipeController;