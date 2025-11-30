const aiRecipeService = require('../services/aiRecipeService');
const imageGenerationService = require('../services/imageGenerationService');
const { createClient } = require('@supabase/supabase-js');
const jwt = require('jsonwebtoken');
const { incrementUsageCounter } = require('../middleware/checkLimits');

// Helper function to get Supabase client
const getSupabaseClient = () => {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_ANON_KEY;
  
  if (!supabaseUrl || !supabaseKey) {
    throw new Error('Supabase configuration missing');
  }
  
  return createClient(supabaseUrl, supabaseKey);
};

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

// AI Recipe Controller Functions
const aiRecipeController = {

  /**
   * Generate AI recipes based on user's inventory and preferences
   * POST /api/ai-recipes/generate
   */
  async generateRecipes(req, res) {
    const requestId = Math.random().toString(36).substring(7);
    
    try {
      console.log(`\n🚀 =============== AI RECIPE GENERATION REQUEST START ===============`);
      console.log(`🚀 REQUEST ID: ${requestId}`);
      console.log(`🚀 Endpoint: POST /api/ai-recipes/generate`);
      console.log(`🚀 Timestamp: ${new Date().toISOString()}`);
      console.log(`🚀 ================================================================\n`);

      // Get user ID from JWT token
      const userId = getUserIdFromToken(req);
      console.log(`👤 [${requestId}] User ID: ${userId}`);

      // Step 1: Get user's current inventory
      console.log(`📦 [${requestId}] Step 1: Fetching user inventory...`);
      const supabase = getSupabaseClient();

      let inventory;

      // Extract ingredient usage preference from questionnaire
      const questionnaire = req.body || {};
      const ingredientUsagePreference = questionnaire.ingredient_usage_preference || 'use_most';
      console.log(`🎛️  [${requestId}] Ingredient usage preference: ${ingredientUsagePreference}`);

      // Check if demo inventory is provided (for welcome tour)
      if (req.body.demoInventory && Array.isArray(req.body.demoInventory) && req.body.demoInventory.length > 0) {
        console.log(`🎯 [${requestId}] Using demo inventory for tour mode (${req.body.demoInventory.length} items)`);
        inventory = req.body.demoInventory;
      } else {
        // Fetch real inventory from database
        console.log(`📦 [${requestId}] Fetching real inventory from database...`);
        const { data: inventoryData, error: inventoryError } = await supabase
          .from('fridge_items')
          .select('*')
          .eq('user_id', userId)
          .order('expiration_date', { ascending: true }); // Prioritize items expiring soon

        if (inventoryError) {
          console.error(`❌ [${requestId}] Inventory fetch error:`, inventoryError);
          throw new Error(`Failed to fetch inventory: ${inventoryError.message}`);
        }

        if (!inventoryData || inventoryData.length === 0) {
          // Allow empty inventory if user selected "Suggest any ingredients" (fully_flexible)
          if (ingredientUsagePreference === 'fully_flexible') {
            console.log(`📭 [${requestId}] Empty inventory but using flexible mode - proceeding without inventory`);
            inventory = []; // Use empty array, AI will generate based on preferences only
          } else {
            console.log(`⚠️  [${requestId}] No inventory items found`);
            return res.status(400).json({
              success: false,
              error: 'No inventory items found. Please add some food items to your fridge first.',
              requestId: requestId
            });
          }
        } else {
          inventory = inventoryData;
        }
      }

      console.log(`📦 [${requestId}] Using ${inventory.length} inventory items`);

      // Step 2: Get user's dietary preferences
      console.log(`🍽️  [${requestId}] Step 2: Fetching user preferences...`);
      const { data: preferencesData, error: prefsError } = await supabase
        .from('user_dietary_preferences')
        .select('*')
        .eq('user_id', userId)
        .single();

      if (prefsError && prefsError.code !== 'PGRST116') {
        console.error(`❌ [${requestId}] Preferences fetch error:`, prefsError);
        throw new Error(`Failed to fetch preferences: ${prefsError.message}`);
      }

      // Use default preferences if none found
      const preferences = preferencesData || {
        dietary_restrictions: [],
        allergies: [],
        custom_allergies: '',
        preferred_cuisines: [],
        cooking_time_preference: ''
      };

      console.log(`🍽️  [${requestId}] User preferences loaded:`, {
        restrictions: preferences.dietary_restrictions?.length || 0,
        allergies: preferences.allergies?.length || 0,
        cuisines: preferences.preferred_cuisines?.length || 0,
        time_pref: preferences.cooking_time_preference || 'any'
      });

      // Step 2.5: Log questionnaire data (already extracted above for ingredient_usage_preference)
      console.log(`📋 [${requestId}] Questionnaire data received:`, {
        meal_type: questionnaire.meal_type || 'not specified',
        cooking_time: questionnaire.cooking_time || 'not specified',
        vibe: questionnaire.vibe || 'not specified',
        cuisine_preference: questionnaire.cuisine_preference || 'not specified',
        dietary_considerations: questionnaire.dietary_considerations?.length || 0,
        additional_notes: questionnaire.additional_notes ? 'yes' : 'no'
      });

      // Step 3: Generate recipes with AI
      const tourMode = req.body.tourMode || false;
      console.log(`🤖 [${requestId}] Step 3: Generating recipes with AI... (tourMode: ${tourMode})`);
      const recipeResult = await aiRecipeService.getRecipesForUser(userId, inventory, preferences, questionnaire, tourMode);
      
      console.log(`🤖 [${requestId}] Recipe generation result:`, {
        cached: recipeResult.cached,
        recipeCount: recipeResult.recipes.length,
        hasImages: recipeResult.imageUrls.length > 0
      });

      // Step 4: ALWAYS generate fresh images (ignore cached imageUrls)
      let finalImageUrls = [];
      
      console.log(`🎨 [${requestId}] Step 4: Generating fresh images (ALWAYS, no cache)...`);
      console.log(`📝 [${requestId}] Recipe cache status: ${recipeResult.cached ? 'cached' : 'fresh'} (but generating fresh images anyway)`);
      
      try {
        // Always generate fresh images regardless of recipe cache status
        console.log(`🎨 [${requestId}] Generating real images for ${recipeResult.recipes.length} recipes...`);

        const imageGenerationPromise = imageGenerationService.generateImagesForRecipes(recipeResult.recipes, userId);
        const timeoutPromise = new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Image generation timeout')), 20000) // 20 second timeout
        );
        
        // Wait for images with timeout
        finalImageUrls = await Promise.race([imageGenerationPromise, timeoutPromise]);
        
        console.log(`✅ [${requestId}] Fresh images generated successfully: ${finalImageUrls.length} images`);
        console.log(`🎯 [${requestId}] Each recipe got a unique, fresh image!`);

        // Update the cached recipes with the generated images
        if (finalImageUrls.length > 0 && recipeResult.cacheId) {
          console.log(`💾 [${requestId}] Updating cache with generated images...`);
          try {
            const supabase = getSupabaseClient();
            const { error: updateError } = await supabase
              .from('ai_generated_recipes')
              .update({ image_urls: finalImageUrls })
              .eq('id', recipeResult.cacheId);

            if (updateError) {
              console.error(`⚠️  [${requestId}] Failed to update images in cache:`, updateError.message);
            } else {
              console.log(`✅ [${requestId}] Images saved to cache successfully`);
            }
          } catch (updateErr) {
            console.error(`⚠️  [${requestId}] Error updating cache with images:`, updateErr.message);
          }
        }

      } catch (imageError) {
        console.error(`❌ [${requestId}] Image generation failed:`, imageError.message);
        console.error(`🔍 [${requestId}] Full error stack:`, imageError.stack);
        
        // DEBUGGING: Don't use placeholders, let the error bubble up
        console.error(`💥 [${requestId}] CRITICAL: Fireworks API is not working!`);
        console.error(`🛑 [${requestId}] Error details:`, {
          message: imageError.message,
          stack: imageError.stack,
          timestamp: new Date().toISOString()
        });
        
        // Return the error to the frontend so we can see what's happening
        return res.status(500).json({
          success: false,
          error: `Image generation failed: ${imageError.message}`,
          details: 'Fireworks API is not working. Check server logs for full details.',
          requestId: requestId,
          timestamp: new Date().toISOString()
        });
      }

      // Step 5: Prepare response
      console.log(`📤 [${requestId}] Step 5: Preparing response...`);
      
      const response = {
        success: true,
        data: {
          recipes: recipeResult.recipes.map((recipe, index) => ({
            ...recipe,
            imageUrl: finalImageUrls[index] || imageGenerationService.getPlaceholderImageUrl(recipe.cuisine_type),
            id: `${requestId}-${index}` // Temporary ID for frontend
          })),
          metadata: {
            cached: recipeResult.cached,
            generatedAt: recipeResult.generatedAt,
            inventoryItemsUsed: inventory.length,
            userPreferencesApplied: !!(preferences.dietary_restrictions?.length || 
                                       preferences.allergies?.length || 
                                       preferences.preferred_cuisines?.length || 
                                       preferences.cooking_time_preference)
          }
        },
        requestId: requestId,
        timestamp: new Date().toISOString()
      };

      console.log(`🎉 [${requestId}] Recipe generation successful!`);
      console.log(`📊 [${requestId}] Generated ${response.data.recipes.length} recipes`);

      // Step 6: Increment usage counter (only after successful generation)
      console.log(`📈 [${requestId}] Step 6: Incrementing AI recipe usage counter...`);
      await incrementUsageCounter(userId, 'ai_recipes');
      console.log(`✅ [${requestId}] Usage counter incremented`);

      res.json(response);

      console.log(`\n✅ [${requestId}] =============== REQUEST COMPLETE ===============\n`);

    } catch (error) {
      console.error(`\n💥 [${requestId}] ========== AI RECIPE GENERATION ERROR ==========`);
      console.error(`💥 [${requestId}] Error:`, error.message);
      console.error(`💥 [${requestId}] Stack:`, error.stack);
      console.error(`💥 [${requestId}] ==============================================\n`);

      const statusCode = error.message.includes('token') ? 401 :
                         error.message.includes('No inventory') ? 400 : 500;

      res.status(statusCode).json({
        success: false,
        error: error.message.includes('token') ? 'Authentication required' :
               error.message.includes('inventory') ? error.message :
               'Failed to generate recipes. Please try again.',
        requestId: requestId,
        timestamp: new Date().toISOString()
      });
    }
  },

  /**
   * Get cached recipes for user (faster endpoint)
   * GET /api/ai-recipes/cached
   */
  async getCachedRecipes(req, res) {
    const requestId = Math.random().toString(36).substring(7);
    
    try {
      console.log(`\n🔍 [${requestId}] Checking for cached recipes...`);

      // Get user ID from JWT token
      const userId = getUserIdFromToken(req);
      console.log(`👤 [${requestId}] User ID: ${userId}`);

      const supabase = getSupabaseClient();
      
      // Get user's latest cached recipes
      const { data: cachedRecipes, error } = await supabase
        .from('ai_generated_recipes')
        .select('*')
        .eq('user_id', userId)
        .gt('expires_at', new Date().toISOString())
        .order('created_at', { ascending: false })
        .limit(1)
        .single();

      if (error && error.code !== 'PGRST116') {
        throw error;
      }

      if (cachedRecipes) {
        console.log(`✅ [${requestId}] Found cached recipes from ${cachedRecipes.created_at}`);

        // Ensure all cached recipes have nutrition (for backward compatibility with old cache)
        const recipesWithNutrition = cachedRecipes.recipes.map((recipe, index) => {
          // If recipe doesn't have nutrition (old cache), add default structure
          if (!recipe.nutrition) {
            console.warn(`⚠️  [${requestId}] Cached recipe ${index + 1} missing nutrition - was cached before nutrition feature`);
            return {
              ...recipe,
              nutrition: {
                perServing: {
                  calories: { amount: 0, unit: 'kcal', percentOfDailyNeeds: 0 },
                  protein: { amount: 0, unit: 'g', percentOfDailyNeeds: 0 },
                  carbohydrates: { amount: 0, unit: 'g', percentOfDailyNeeds: 0 },
                  fat: { amount: 0, unit: 'g', percentOfDailyNeeds: 0 },
                  fiber: { amount: 0, unit: 'g', percentOfDailyNeeds: 0 },
                  sugar: { amount: 0, unit: 'g', percentOfDailyNeeds: 0 },
                  sodium: { amount: 0, unit: 'mg', percentOfDailyNeeds: 0 }
                },
                caloricBreakdown: { percentProtein: 0, percentFat: 0, percentCarbs: 0 },
                isAIEstimated: false,
                confidence: 0,
                estimationNotes: 'Regenerate recipes to get nutrition data'
              }
            };
          }
          return recipe;
        });

        const response = {
          success: true,
          data: {
            recipes: recipesWithNutrition.map((recipe, index) => ({
              ...recipe,
              imageUrl: cachedRecipes.image_urls[index] ||
                       imageGenerationService.getPlaceholderImageUrl(recipe.cuisine_type),
              id: `cached-${index}`
            })),
            metadata: {
              cached: true,
              generatedAt: cachedRecipes.created_at,
              expiresAt: cachedRecipes.expires_at
            }
          },
          requestId: requestId
        };

        res.json(response);
      } else {
        console.log(`🚫 [${requestId}] No cached recipes found`);
        
        res.json({
          success: true,
          data: null,
          message: 'No cached recipes found',
          requestId: requestId
        });
      }

    } catch (error) {
      console.error(`❌ [${requestId}] Error checking cached recipes:`, error);
      
      const statusCode = error.message.includes('token') ? 401 : 500;
      
      res.status(statusCode).json({
        success: false,
        error: error.message.includes('token') ? 'Authentication required' : 'Failed to check cached recipes',
        requestId: requestId
      });
    }
  },

  /**
   * Clear user's recipe cache (force regeneration)
   * DELETE /api/ai-recipes/cache
   */
  async clearCache(req, res) {
    const requestId = Math.random().toString(36).substring(7);
    
    try {
      console.log(`\n🗑️  [${requestId}] Clearing recipe cache...`);

      // Get user ID from JWT token
      const userId = getUserIdFromToken(req);
      console.log(`👤 [${requestId}] User ID: ${userId}`);

      const supabase = getSupabaseClient();
      
      const { error } = await supabase
        .from('ai_generated_recipes')
        .delete()
        .eq('user_id', userId);

      if (error) {
        throw error;
      }

      console.log(`✅ [${requestId}] Recipe cache cleared successfully`);
      
      res.json({
        success: true,
        message: 'Recipe cache cleared successfully',
        requestId: requestId
      });

    } catch (error) {
      console.error(`❌ [${requestId}] Error clearing cache:`, error);
      
      const statusCode = error.message.includes('token') ? 401 : 500;
      
      res.status(statusCode).json({
        success: false,
        error: error.message.includes('token') ? 'Authentication required' : 'Failed to clear cache',
        requestId: requestId
      });
    }
  },

  /**
   * Get past AI recipe generations (history)
   * GET /api/ai-recipes/history?limit=10
   */
  async getHistory(req, res) {
    const requestId = Math.random().toString(36).substring(7);

    try {
      console.log(`\n📚 [${requestId}] Fetching AI recipe history...`);

      // Get user ID from JWT token
      const userId = getUserIdFromToken(req);
      console.log(`👤 [${requestId}] User ID: ${userId}`);

      // Get limit from query params (default 10)
      const limit = parseInt(req.query.limit) || 10;
      console.log(`📊 [${requestId}] Limit: ${limit}`);

      const supabase = getSupabaseClient();

      // Fetch all past AI recipe generations for this user
      const { data: pastGenerations, error } = await supabase
        .from('ai_generated_recipes')
        .select('*')
        .eq('user_id', userId)
        .gt('expires_at', new Date().toISOString())  // Only non-expired
        .order('created_at', { ascending: false })
        .limit(limit);

      if (error) {
        throw error;
      }

      if (pastGenerations && pastGenerations.length > 0) {
        console.log(`✅ [${requestId}] Found ${pastGenerations.length} past AI recipe generations`);

        const response = {
          success: true,
          data: {
            generations: pastGenerations.map(gen => ({
              id: gen.id,
              recipes: gen.recipes,
              image_urls: gen.image_urls,
              questionnaire: gen.questionnaire_data,
              created_at: gen.created_at,
              expires_at: gen.expires_at
            }))
          },
          requestId: requestId
        };

        res.json(response);
      } else {
        console.log(`🚫 [${requestId}] No past AI recipes found`);

        res.json({
          success: true,
          data: {
            generations: []
          },
          message: 'No past AI recipes found',
          requestId: requestId
        });
      }

    } catch (error) {
      console.error(`❌ [${requestId}] Error fetching AI recipe history:`, error);

      const statusCode = error.message.includes('token') ? 401 : 500;

      res.status(statusCode).json({
        success: false,
        error: error.message.includes('token') ? 'Authentication required' : 'Failed to fetch recipe history',
        requestId: requestId
      });
    }
  },

  /**
   * Delete a specific AI recipe generation
   * DELETE /api/ai-recipes/:generationId
   */
  async deleteGeneration(req, res) {
    const requestId = Math.random().toString(36).substring(7);

    try {
      console.log(`\n🗑️  [${requestId}] Deleting AI recipe generation...`);

      const userId = getUserIdFromToken(req);
      const generationId = req.params.generationId;

      console.log(`👤 [${requestId}] User ID: ${userId}`);
      console.log(`📋 [${requestId}] Generation ID: ${generationId}`);

      const supabase = getSupabaseClient();

      // Delete the generation (only if it belongs to this user)
      const { error } = await supabase
        .from('ai_generated_recipes')
        .delete()
        .eq('id', generationId)
        .eq('user_id', userId);

      if (error) {
        throw error;
      }

      console.log(`✅ [${requestId}] Generation deleted successfully`);

      res.json({
        success: true,
        message: 'AI recipe generation deleted successfully',
        requestId: requestId
      });

    } catch (error) {
      console.error(`❌ [${requestId}] Error deleting generation:`, error);

      const statusCode = error.message.includes('token') ? 401 : 500;

      res.status(statusCode).json({
        success: false,
        error: error.message.includes('token') ? 'Authentication required' : 'Failed to delete generation',
        requestId: requestId
      });
    }
  },

  /**
   * Get AI recipe generation analytics (for admin/debugging)
   * GET /api/ai-recipes/analytics
   */
  async getAnalytics(req, res) {
    const requestId = Math.random().toString(36).substring(7);
    
    try {
      console.log(`\n📊 [${requestId}] Fetching AI recipe analytics...`);

      // Get user ID from JWT token
      const userId = getUserIdFromToken(req);

      const supabase = getSupabaseClient();
      
      // Get user's generation analytics
      const { data: analytics, error } = await supabase
        .from('ai_recipe_analytics')
        .select('*')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(50);

      if (error) {
        throw error;
      }

      // Get image generation stats
      const imageStats = await imageGenerationService.getImageStats();

      // Calculate summary statistics
      const totalGenerations = analytics.length;
      const cacheHitRate = analytics.length > 0 ? 
        (analytics.filter(a => a.cache_hit).length / totalGenerations * 100).toFixed(1) : 0;
      const avgGenerationTime = analytics.length > 0 ?
        Math.round(analytics.reduce((sum, a) => sum + (a.generation_time_ms || 0), 0) / totalGenerations) : 0;
      const totalCost = analytics.reduce((sum, a) => sum + parseFloat(a.total_cost || 0), 0);

      const response = {
        success: true,
        data: {
          summary: {
            totalGenerations,
            cacheHitRate: `${cacheHitRate}%`,
            averageGenerationTime: `${avgGenerationTime}ms`,
            totalCost: `$${totalCost.toFixed(4)}`,
            errorRate: analytics.filter(a => a.error_type).length
          },
          recentGenerations: analytics.slice(0, 10),
          imageStats: imageStats
        },
        requestId: requestId
      };

      res.json(response);

    } catch (error) {
      console.error(`❌ [${requestId}] Error fetching analytics:`, error);
      
      const statusCode = error.message.includes('token') ? 401 : 500;
      
      res.status(statusCode).json({
        success: false,
        error: error.message.includes('token') ? 'Authentication required' : 'Failed to fetch analytics',
        requestId: requestId
      });
    }
  },

  /**
   * Health check for AI recipe services
   * GET /api/ai-recipes/health
   */
  async healthCheck(req, res) {
    const requestId = Math.random().toString(36).substring(7);
    
    try {
      const hasOpenRouter = !!process.env.OPENROUTER_API_KEY;
      const hasFireworks = !!process.env.FIREWORKS_API_KEY;
      const hasSupabase = !!process.env.SUPABASE_URL && !!process.env.SUPABASE_ANON_KEY;
      
      const allHealthy = hasOpenRouter && hasFireworks && hasSupabase;
      
      res.status(allHealthy ? 200 : 503).json({
        success: allHealthy,
        service: 'AI Recipe Generation Service',
        status: allHealthy ? 'healthy' : 'unhealthy',
        checks: {
          openRouterConfigured: hasOpenRouter,
          fireworksConfigured: hasFireworks,
          supabaseConfigured: hasSupabase,
          geminiModel: 'google/gemini-2.0-flash-001',
          fluxModel: 'flux-1-dev-fp8'
        },
        requestId: requestId,
        timestamp: new Date().toISOString()
      });

    } catch (error) {
      res.status(500).json({
        success: false,
        service: 'AI Recipe Generation Service',
        status: 'error',
        error: error.message,
        requestId: requestId
      });
    }
  }
};

module.exports = aiRecipeController;