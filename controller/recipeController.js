const jwt = require('jsonwebtoken');
const recipeService = require('../services/recipeService');
const inventoryDeductionService = require('../services/inventoryDeductionService');
const tastyService = require('../services/tastyService');
const { createClient } = require('@supabase/supabase-js');

// JWT secret
const JWT_SECRET = process.env.JWT_SECRET || 'your-super-secret-jwt-key-change-in-production';

// Helper function to get Supabase client
const getSupabaseClient = () => {
  return createClient(
    process.env.SUPABASE_URL || 'your-supabase-url',
    process.env.SUPABASE_ANON_KEY || 'your-supabase-anon-key'
  );
};

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
      
      if (!id) {
        throw new Error('Recipe ID is required');
      }
      
      let recipeDetails;
      
      // Check if this might be a Tasty recipe by attempting to get it from cache first
      // Tasty recipes are cached with their original ID (could be string)
      try {
        console.log(`📖 [${requestId}] Attempting to get recipe from Tasty cache: ${id}`);
        recipeDetails = await tastyService.getRecipeDetails(id);
        console.log(`📖 [${requestId}] Found Tasty recipe: ${recipeDetails.title}`);
      } catch (tastyError) {
        // If not in Tasty cache, try Spoonacular
        console.log(`📖 [${requestId}] Not a Tasty recipe, trying Spoonacular: ${tastyError.message}`);
        
        if (isNaN(parseInt(id))) {
          throw new Error('Invalid recipe ID format for Spoonacular');
        }
        
        recipeDetails = await recipeService.getRecipeDetails(parseInt(id));
        console.log(`📖 [${requestId}] Found Spoonacular recipe: ${recipeDetails.title}`);
      }
      
      console.log(`📖 [${requestId}] Retrieved details for: ${recipeDetails.title}`);
      
      // Extract step-by-step instructions from analyzedInstructions
      let instructionSteps = [];
      if (recipeDetails.analyzedInstructions && recipeDetails.analyzedInstructions.length > 0) {
        const firstSection = recipeDetails.analyzedInstructions[0];
        if (firstSection.steps && Array.isArray(firstSection.steps)) {
          instructionSteps = firstSection.steps.map(step => step.step);
        }
      }

      // Extract and format nutrition data
      let nutrition = null;
      if (recipeDetails.nutrition) {
        const nutrients = recipeDetails.nutrition.nutrients || [];
        const caloricBreakdown = recipeDetails.nutrition.caloricBreakdown || {};
        
        // Find key nutrients
        const findNutrient = (name) => {
          const nutrient = nutrients.find(n => 
            n.name.toLowerCase().includes(name.toLowerCase())
          );
          return nutrient ? {
            amount: Math.round(nutrient.amount * 10) / 10,
            unit: nutrient.unit,
            percentOfDailyNeeds: Math.round(nutrient.percentOfDailyNeeds)
          } : null;
        };
        
        nutrition = {
          perServing: {
            calories: findNutrient('Calories'),
            protein: findNutrient('Protein'),
            carbohydrates: findNutrient('Carbohydrates'),
            fat: findNutrient('Fat'),
            saturatedFat: findNutrient('Saturated Fat'),
            fiber: findNutrient('Fiber'),
            sugar: findNutrient('Sugar'),
            sodium: findNutrient('Sodium'),
            cholesterol: findNutrient('Cholesterol')
          },
          caloricBreakdown: {
            percentProtein: Math.round(caloricBreakdown.percentProtein || 0),
            percentFat: Math.round(caloricBreakdown.percentFat || 0),
            percentCarbs: Math.round(caloricBreakdown.percentCarbs || 0)
          },
          healthScore: recipeDetails.healthScore || 0
        };
      }

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
        instructionSteps: instructionSteps, // Add structured step-by-step instructions
        nutrition: nutrition, // Add formatted nutrition data
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
        vegan: recipeDetails.vegan,
        
        // Tasty-specific features
        video: recipeDetails.video || null,
        _source: recipeDetails._source || 'spoonacular',
        _hasVideo: recipeDetails._hasVideo || false
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
   * Cook a recipe and deduct ingredients from inventory
   * POST /api/recipes/:id/cook
   */
  async markRecipeCooked(req, res) {
    const requestId = Math.random().toString(36).substring(7);
    
    try {
      console.log(`\n👨‍🍳 ================ COOK RECIPE START ================`);
      console.log(`👨‍🍳 REQUEST ID: ${requestId}`);
      
      const { id } = req.params;
      const { ingredients = [], imageUrl, mealType, mealName, servings = 1 } = req.body;
      
      // Get user ID from JWT token
      const userId = getUserIdFromToken(req);
      console.log(`👨‍🍳 [${requestId}] User ID: ${userId}, Recipe ID: ${id}`);
      console.log(`👨‍🍳 [${requestId}] Meal name: ${mealName}`);
      console.log(`👨‍🍳 [${requestId}] Meal type: ${mealType}`);
      console.log(`👨‍🍳 [${requestId}] Servings: ${servings}`);
      
      if (!id || isNaN(parseInt(id))) {
        throw new Error('Invalid recipe ID');
      }
      
      if (!Array.isArray(ingredients) || ingredients.length === 0) {
        throw new Error('No ingredients provided');
      }
      
      // Validate meal type if provided
      const validMealTypes = ['breakfast', 'lunch', 'dinner', 'snack'];
      if (mealType && !validMealTypes.includes(mealType)) {
        throw new Error('Invalid meal type. Must be breakfast, lunch, dinner, or snack');
      }
      
      console.log(`👨‍🍳 [${requestId}] Processing ${ingredients.length} ingredients for deduction`);
      
      // Format ingredients for deduction service
      const formattedIngredients = ingredients.map(ing => ({
        name: ing.name,
        quantity: ing.quantity * servings, // Multiply by servings
        unit: ing.unit || 'piece'
      }));
      
      // Deduct ingredients from inventory and save meal log
      const deductionResult = await inventoryDeductionService.deductFromInventory(
        userId,
        formattedIngredients,
        imageUrl,  // Recipe image URL
        mealType,  // Meal type (breakfast, lunch, dinner, snack)
        null,      // Use current date
        mealName   // Recipe title as meal name
      );
      
      console.log(`👨‍🍳 [${requestId}] Deduction results:`, deductionResult.summary);
      
      // Return the results
      res.json({
        success: true,
        results: deductionResult,
        message: `Successfully cooked ${mealName} with ${deductionResult.summary.successfulDeductions} items deducted`,
        requestId: requestId,
        timestamp: new Date().toISOString()
      });
      
      console.log(`\n✅ [${requestId}] ============= COOK RECIPE COMPLETE =============\n`);
      
    } catch (error) {
      console.error(`\n💥 [${requestId}] ========== COOK RECIPE ERROR ==========`);
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