const jwt = require('jsonwebtoken');
const recipeService = require('../services/recipeService');
const inventoryDeductionService = require('../services/inventoryDeductionService');
const { getServiceClient } = require('../config/supabase');

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

// Community pool cache — the response is identical for every user, so one
// query per TTL serves everyone.
const COMMUNITY_POOL_TTL_MS = 6 * 60 * 60 * 1000;
const COMMUNITY_POOL_SIZE = 50;
let communityPoolCache = { recipes: null, expiresAt: 0 };

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

      // Check if Spoonacular is disabled via feature flag
      if (process.env.ENABLE_SPOONACULAR_RECIPES === 'false') {
        console.log(`⚠️  [${requestId}] Spoonacular recipes disabled by feature flag`);
        return res.json({
          success: true,
          suggestions: [],
          count: 0,
          requestId: requestId,
          meta: {
            disabled: true,
            reason: 'Spoonacular API disabled - use AI recipe features instead'
          }
        });
      }

      // Check for demo inventory (welcome tour mode)
      const demoInventory = req.body?.demoInventory;
      if (demoInventory && Array.isArray(demoInventory) && demoInventory.length > 0) {
        console.log(`🎯 [${requestId}] Using demo inventory for tour mode (${demoInventory.length} items)`);
      }

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
        ranking: parseInt(ranking),
        demoInventory: demoInventory // Pass demo inventory to service
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
      
      // Verify recipe ID is valid
      if (isNaN(parseInt(id))) {
        throw new Error('Invalid recipe ID format');
      }

      // Get recipe details from Spoonacular
      console.log(`📖 [${requestId}] Fetching recipe from Spoonacular: ${id}`);
      const recipeDetails = await recipeService.getRecipeDetails(parseInt(id));
      console.log(`📖 [${requestId}] Found recipe: ${recipeDetails.title}`);
      
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
   * Community recipe pool for the Home "Suggested Meal" card, used only when
   * the user has no saved recipes of their own.
   * GET /api/recipes/community-pool
   *
   * saved_recipes has no sharing flag, so the scope here is deliberate:
   * - public-source imports only — never manual/scanned/voice, which are the
   *   user's own content and were never meant to be seen by anyone else
   * - an explicit column list: no user_id, user_notes, rating, user_edited
   * - one row per source_url, so a viral recipe saved by 40 people is one entry
   * - Supabase-hosted images only; a failed Instagram re-host can leave an
   *   expiring CDN URL behind, and a dead hero image is worse than no card
   * - at least one ingredient and one instruction step — imports can succeed
   *   with neither
   * The client ranks the pool against the user's own inventory.
   */
  async getCommunityPool(req, res) {
    const requestId = Math.random().toString(36).substring(7);

    try {
      getUserIdFromToken(req);

      if (communityPoolCache.recipes && communityPoolCache.expiresAt > Date.now()) {
        return res.json({
          success: true,
          recipes: communityPoolCache.recipes,
          count: communityPoolCache.recipes.length,
          cached: true,
          requestId
        });
      }

      const supabase = getServiceClient();
      const { data, error } = await supabase
        .from('saved_recipes')
        .select(
          'id, title, summary, image, extendedIngredients, analyzedInstructions, ' +
          'readyInMinutes, servings, source_author, source_type, source_url, ' +
          'cuisines, dishTypes, vegetarian, vegan, glutenFree, dairyFree, times_cooked, created_at'
        )
        .in('source_type', ['instagram', 'web', 'popular'])
        .like('image', '%supabase.co/storage/%')
        .order('times_cooked', { ascending: false })
        .order('created_at', { ascending: false })
        .limit(400);

      if (error) throw error;

      const seen = new Set();
      const recipes = [];
      for (const row of data || []) {
        const ingredients = Array.isArray(row.extendedIngredients) ? row.extendedIngredients : [];
        const steps = Array.isArray(row.analyzedInstructions)
          ? row.analyzedInstructions.reduce((n, block) => n + (block?.steps?.length || 0), 0)
          : 0;
        if (ingredients.length === 0 || steps === 0) continue;

        const key = row.source_url
          ? row.source_url.trim().toLowerCase()
          : `${(row.title || '').trim().toLowerCase()}|${(row.source_author || '').trim().toLowerCase()}`;
        if (seen.has(key)) continue;
        seen.add(key);

        // The card only needs the summary fields; the detail screen fetches
        // the full recipe through /saved-recipes/:id/public on tap.
        const { analyzedInstructions, ...summary } = row;
        recipes.push(summary);
        if (recipes.length >= COMMUNITY_POOL_SIZE) break;
      }

      communityPoolCache = { recipes, expiresAt: Date.now() + COMMUNITY_POOL_TTL_MS };
      console.log(`🍲 [${requestId}] Community pool rebuilt: ${recipes.length} recipes from ${(data || []).length} rows`);

      res.json({ success: true, recipes, count: recipes.length, cached: false, requestId });

    } catch (error) {
      console.error(`❌ [${requestId}] Community pool error:`, error.message);
      if (error.message === 'No token provided' || error.message === 'Invalid token') {
        return res.status(401).json({ success: false, error: 'Authentication required', requestId });
      }
      res.status(500).json({ success: false, error: 'Failed to load community recipes', requestId });
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