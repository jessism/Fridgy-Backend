const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/auth');
const { createClient } = require('@supabase/supabase-js');
const googleCalendarService = require('../services/googleCalendarService');
const ingredientAggregationService = require('../services/ingredientAggregationService');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

/**
 * Helper: Get user's calendar connection and tokens for deletion
 */
async function getCalendarTokens(userId) {
  const { data: connection, error } = await supabase
    .from('user_calendar_connections')
    .select('*')
    .eq('user_id', userId)
    .eq('provider', 'google')
    .eq('is_active', true)
    .single();

  if (error || !connection) {
    return null;
  }

  // Check if token needs refresh
  const now = new Date();
  const expiry = new Date(connection.token_expiry);

  if (expiry <= now) {
    try {
      const newTokens = await googleCalendarService.refreshAccessToken(connection.refresh_token);
      await supabase
        .from('user_calendar_connections')
        .update({
          access_token: newTokens.access_token,
          token_expiry: newTokens.expiry_date ? new Date(newTokens.expiry_date).toISOString() : null,
          updated_at: new Date().toISOString()
        })
        .eq('id', connection.id);
      connection.access_token = newTokens.access_token;
    } catch (refreshError) {
      console.error('[MealPlans] Token refresh failed:', refreshError);
      return null;
    }
  }

  return {
    access_token: connection.access_token,
    refresh_token: connection.refresh_token
  };
}

// GET /api/meal-plans - Get meal plans for a date range
router.get('/', authMiddleware.authenticateToken, async (req, res) => {
  try {
    const userId = req.user?.userId || req.user?.id;
    const { start_date, end_date } = req.query;

    console.log(`[MealPlans] Fetching plans for user ${userId}, range: ${start_date} to ${end_date}`);

    let query = supabase
      .from('meal_plans')
      .select(`
        *,
        recipe:saved_recipes(id, title, image, readyInMinutes, source_type)
      `)
      .eq('user_id', userId)
      .order('date', { ascending: true })
      .order('meal_type', { ascending: true });

    if (start_date) {
      query = query.gte('date', start_date);
    }
    if (end_date) {
      query = query.lte('date', end_date);
    }

    const { data, error } = await query;

    if (error) {
      console.error('[MealPlans] Fetch error:', error);
      throw error;
    }

    console.log(`[MealPlans] Found ${data?.length || 0} plans`);

    res.json({
      success: true,
      plans: data || []
    });

  } catch (error) {
    console.error('[MealPlans] Get plans error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch meal plans'
    });
  }
});

// GET /api/meal-plans/date/:date - Get all meals for a specific date
router.get('/date/:date', authMiddleware.authenticateToken, async (req, res) => {
  try {
    const userId = req.user?.userId || req.user?.id;
    const { date } = req.params;

    console.log(`[MealPlans] Fetching plans for user ${userId}, date: ${date}`);

    const { data, error } = await supabase
      .from('meal_plans')
      .select(`
        *,
        recipe:saved_recipes(id, title, image, readyInMinutes, source_type, extendedIngredients, analyzedInstructions, nutrition, source_author, source_url, servings, summary)
      `)
      .eq('user_id', userId)
      .eq('date', date)
      .order('meal_type', { ascending: true });

    if (error) {
      console.error('[MealPlans] Fetch by date error:', error);
      throw error;
    }

    // Transform into meal slots object
    const mealSlots = {
      breakfast: null,
      lunch: null,
      dinner: null,
      snack: null
    };

    (data || []).forEach(plan => {
      mealSlots[plan.meal_type] = plan;
    });

    console.log(`[MealPlans] Found plans for date ${date}:`, Object.keys(mealSlots).filter(k => mealSlots[k]));

    res.json({
      success: true,
      date,
      meals: mealSlots
    });

  } catch (error) {
    console.error('[MealPlans] Get plans by date error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch meal plans for date'
    });
  }
});

// GET /api/meal-plans/week-counts - Get meal counts for a week (for calendar indicators)
router.get('/week-counts', authMiddleware.authenticateToken, async (req, res) => {
  try {
    const userId = req.user?.userId || req.user?.id;
    const { start_date, end_date } = req.query;

    console.log(`[MealPlans] Fetching week counts for user ${userId}, range: ${start_date} to ${end_date}`);

    const { data, error } = await supabase
      .from('meal_plans')
      .select('date, meal_type')
      .eq('user_id', userId)
      .gte('date', start_date)
      .lte('date', end_date);

    if (error) {
      console.error('[MealPlans] Week counts error:', error);
      throw error;
    }

    // Group by date and count meals
    const counts = {};
    (data || []).forEach(plan => {
      if (!counts[plan.date]) {
        counts[plan.date] = 0;
      }
      counts[plan.date]++;
    });

    console.log(`[MealPlans] Week counts:`, counts);

    res.json({
      success: true,
      counts
    });

  } catch (error) {
    console.error('[MealPlans] Get week counts error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch meal counts'
    });
  }
});

// POST /api/meal-plans/generate-grocery-list - Generate consolidated grocery list from meal plans
router.post('/generate-grocery-list', authMiddleware.authenticateToken, async (req, res) => {
  try {
    const userId = req.user?.userId || req.user?.id;
    const { start_date, end_date, list_name, list_color } = req.body;

    console.log(`[MealPlans] Generating grocery list for user ${userId}, range: ${start_date} to ${end_date}`);

    // Validate required fields
    if (!start_date || !end_date) {
      return res.status(400).json({
        success: false,
        error: 'start_date and end_date are required'
      });
    }

    // 1. Fetch meal plans in date range with full recipe data (including extendedIngredients)
    const { data: mealPlans, error: fetchError } = await supabase
      .from('meal_plans')
      .select(`
        *,
        recipe:saved_recipes(id, title, image, readyInMinutes, source_type, extendedIngredients)
      `)
      .eq('user_id', userId)
      .gte('date', start_date)
      .lte('date', end_date)
      .order('date', { ascending: true });

    if (fetchError) {
      console.error('[MealPlans] Fetch error for grocery list:', fetchError);
      throw fetchError;
    }

    console.log(`[MealPlans] Found ${mealPlans?.length || 0} meal plans for grocery list`);

    if (!mealPlans || mealPlans.length === 0) {
      return res.json({
        success: true,
        ingredients: {},
        recipe_count: 0,
        meal_count: 0,
        message: 'No meals found in the selected date range'
      });
    }

    // 2. Extract recipes (from saved_recipes or recipe_snapshot)
    const recipes = mealPlans
      .map(plan => {
        // Prefer saved recipe, fall back to snapshot
        if (plan.recipe?.extendedIngredients) {
          return {
            title: plan.recipe.title,
            extendedIngredients: plan.recipe.extendedIngredients
          };
        } else if (plan.recipe_snapshot?.extendedIngredients) {
          return {
            title: plan.recipe_snapshot.title,
            extendedIngredients: plan.recipe_snapshot.extendedIngredients
          };
        }
        return null;
      })
      .filter(r => r !== null && r.extendedIngredients?.length > 0);

    console.log(`[MealPlans] Found ${recipes.length} recipes with ingredients`);

    // 2b. Extract unique recipe metadata for carousel display with occurrence counts
    const recipeCountMap = new Map(); // recipeId -> { recipe metadata, count }
    mealPlans.forEach((plan) => {
      const recipe = plan.recipe || plan.recipe_snapshot;
      if (!recipe || !recipe.title) return;

      // Use recipe.id, plan.recipe_id, or generate unique key from title
      const recipeId = recipe?.id || plan.recipe_id || `snapshot_${recipe.title}`;

      if (recipeCountMap.has(recipeId)) {
        // Increment count for existing recipe
        recipeCountMap.get(recipeId).count++;
      } else {
        // Add new recipe with count of 1 and full data for modal display
        recipeCountMap.set(recipeId, {
          id: recipeId,
          title: recipe.title,
          image: recipe.image,
          readyInMinutes: recipe.readyInMinutes,
          servings: recipe.servings || 1,
          count: 1,
          // Full recipe data for RecipeDetailModal
          extendedIngredients: recipe.extendedIngredients || [],
          analyzedInstructions: recipe.analyzedInstructions || [],
          summary: recipe.summary || '',
          nutrition: recipe.nutrition || null,
          // Source attribution for Instagram recipes
          source_type: recipe.source_type || null,
          source_author: recipe.source_author || null,
          source_url: recipe.source_url || null
        });
      }
    });
    const uniqueRecipes = Array.from(recipeCountMap.values());
    console.log(`[MealPlans] Found ${uniqueRecipes.length} unique recipes for carousel`);

    // 3. Aggregate ingredients with unit conversion
    const aggregatedByCategory = await ingredientAggregationService.aggregateIngredients(recipes);
    const summary = ingredientAggregationService.getSummary(aggregatedByCategory);

    console.log(`[MealPlans] Aggregated ${summary.totalItems} ingredients into ${summary.categoryCount} categories`);

    // 4. If list_name provided, create the shopping list
    if (list_name) {
      // Flatten grouped ingredients for shopping list creation
      const items = ingredientAggregationService.flattenGrouped(aggregatedByCategory);

      // Generate unique share code
      const generateShareCode = () => {
        const part1 = Math.random().toString(36).substring(2, 6).toUpperCase();
        const part2 = Math.random().toString(36).substring(2, 6).toUpperCase();
        return `${part1}-${part2}`;
      };

      let shareCode;
      let codeIsUnique = false;
      while (!codeIsUnique) {
        shareCode = generateShareCode();
        const { data: existing } = await supabase
          .from('shopping_lists')
          .select('id')
          .eq('share_code', shareCode)
          .single();
        codeIsUnique = !existing;
      }

      // Create the shopping list with recipe metadata for carousel
      const { data: newList, error: listError } = await supabase
        .from('shopping_lists')
        .insert({
          name: list_name,
          color: list_color || '#c3f0ca',
          owner_id: userId,
          share_code: shareCode,
          settings: { source_recipes: uniqueRecipes }
        })
        .select()
        .single();

      if (listError) {
        console.error('[MealPlans] Shopping list creation error:', listError);
        throw listError;
      }

      // Add owner as member
      await supabase
        .from('shopping_list_members')
        .insert({
          list_id: newList.id,
          user_id: userId,
          role: 'owner',
          invited_by_name: 'Meal Plan'
        });

      // Add items to the shopping list
      if (items.length > 0) {
        const itemsToInsert = items.map((item, index) => ({
          list_id: newList.id,
          name: item.name,
          quantity: item.quantity,
          unit: item.unit,
          category: item.category || 'Other',
          added_by: userId,
          added_by_name: 'Meal Plan',
          order_index: index,
          is_checked: false
        }));

        const { error: itemsError } = await supabase
          .from('shopping_list_items')
          .insert(itemsToInsert);

        if (itemsError) {
          console.error('[MealPlans] Shopping list items insertion error:', itemsError);
          // Don't throw - list was created, items just failed
        }
      }

      console.log(`[MealPlans] Created shopping list ${newList.id} with ${items.length} items`);

      return res.json({
        success: true,
        list: newList,
        ingredients: aggregatedByCategory,
        recipe_count: recipes.length,
        meal_count: mealPlans.length,
        item_count: items.length,
        message: `Created grocery list with ${items.length} items from ${recipes.length} recipes`
      });
    }

    // 5. Return preview only (no list_name provided)
    res.json({
      success: true,
      ingredients: aggregatedByCategory,
      recipe_count: recipes.length,
      meal_count: mealPlans.length,
      item_count: summary.totalItems
    });

  } catch (error) {
    console.error('[MealPlans] Generate grocery list error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to generate grocery list'
    });
  }
});

// POST /api/meal-plans - Create a new meal plan entry
router.post('/', authMiddleware.authenticateToken, async (req, res) => {
  try {
    const userId = req.user?.userId || req.user?.id;
    const { date, meal_type, recipe_id, recipe_source, recipe_snapshot } = req.body;

    console.log(`[MealPlans] Creating plan for user ${userId}:`, { date, meal_type, recipe_id, recipe_source });

    // Validate required fields
    if (!date || !meal_type) {
      return res.status(400).json({
        success: false,
        error: 'Date and meal_type are required'
      });
    }

    // Validate meal_type
    if (!['breakfast', 'lunch', 'dinner', 'snack'].includes(meal_type)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid meal_type. Must be breakfast, lunch, dinner, or snack'
      });
    }

    // Prepare the meal plan data
    const mealPlanData = {
      user_id: userId,
      date,
      meal_type,
      recipe_id: recipe_id || null,
      recipe_source: recipe_source || 'saved',
      recipe_snapshot: recipe_snapshot || null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };

    // Use upsert to handle both create and update (since we have unique constraint)
    const { data, error } = await supabase
      .from('meal_plans')
      .upsert(mealPlanData, {
        onConflict: 'user_id,date,meal_type',
        ignoreDuplicates: false
      })
      .select(`
        *,
        recipe:saved_recipes(id, title, image, readyInMinutes, source_type)
      `)
      .single();

    if (error) {
      console.error('[MealPlans] Create error:', error);
      throw error;
    }

    console.log(`[MealPlans] Plan created/updated successfully:`, data.id);

    res.json({
      success: true,
      plan: data,
      message: 'Meal plan saved successfully'
    });

  } catch (error) {
    console.error('[MealPlans] Create plan error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to create meal plan'
    });
  }
});

// PUT /api/meal-plans/:id - Update a meal plan
router.put('/:id', authMiddleware.authenticateToken, async (req, res) => {
  try {
    const userId = req.user?.userId || req.user?.id;
    const { id } = req.params;
    const { recipe_id, recipe_source, recipe_snapshot, scheduled_time } = req.body;

    console.log(`[MealPlans] Updating plan ${id} for user ${userId}`);

    // Verify ownership
    const { data: existing, error: fetchError } = await supabase
      .from('meal_plans')
      .select('id, user_id')
      .eq('id', id)
      .single();

    if (fetchError || !existing) {
      return res.status(404).json({
        success: false,
        error: 'Meal plan not found'
      });
    }

    if (existing.user_id !== userId) {
      return res.status(403).json({
        success: false,
        error: 'Not authorized to update this meal plan'
      });
    }

    // Update the plan
    const updateData = {
      updated_at: new Date().toISOString()
    };

    if (recipe_id !== undefined) updateData.recipe_id = recipe_id;
    if (recipe_source !== undefined) updateData.recipe_source = recipe_source;
    if (recipe_snapshot !== undefined) updateData.recipe_snapshot = recipe_snapshot;
    if (scheduled_time !== undefined) updateData.scheduled_time = scheduled_time;

    const { data, error } = await supabase
      .from('meal_plans')
      .update(updateData)
      .eq('id', id)
      .select(`
        *,
        recipe:saved_recipes(id, title, image, readyInMinutes, source_type)
      `)
      .single();

    if (error) {
      console.error('[MealPlans] Update error:', error);
      throw error;
    }

    console.log(`[MealPlans] Plan updated successfully`);

    res.json({
      success: true,
      plan: data,
      message: 'Meal plan updated successfully'
    });

  } catch (error) {
    console.error('[MealPlans] Update plan error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to update meal plan'
    });
  }
});

// DELETE /api/meal-plans/:id - Delete a meal plan
router.delete('/:id', authMiddleware.authenticateToken, async (req, res) => {
  try {
    const userId = req.user?.userId || req.user?.id;
    const { id } = req.params;

    console.log(`[MealPlans] Deleting plan ${id} for user ${userId}`);

    // Verify ownership and get calendar_event_id
    const { data: existing, error: fetchError } = await supabase
      .from('meal_plans')
      .select('id, user_id, calendar_event_id')
      .eq('id', id)
      .single();

    if (fetchError || !existing) {
      return res.status(404).json({
        success: false,
        error: 'Meal plan not found'
      });
    }

    if (existing.user_id !== userId) {
      return res.status(403).json({
        success: false,
        error: 'Not authorized to delete this meal plan'
      });
    }

    // Delete from Google Calendar if synced
    if (existing.calendar_event_id) {
      try {
        const tokens = await getCalendarTokens(userId);
        if (tokens) {
          await googleCalendarService.deleteMealEvent(tokens, existing.calendar_event_id);
          console.log(`[MealPlans] Deleted calendar event: ${existing.calendar_event_id}`);
        }
      } catch (calendarError) {
        // Log but don't fail - continue with meal plan deletion
        console.warn('[MealPlans] Failed to delete calendar event:', calendarError.message);
      }
    }

    // Delete the plan
    const { error } = await supabase
      .from('meal_plans')
      .delete()
      .eq('id', id);

    if (error) {
      console.error('[MealPlans] Delete error:', error);
      throw error;
    }

    console.log(`[MealPlans] Plan deleted successfully`);

    res.json({
      success: true,
      message: 'Meal plan deleted successfully'
    });

  } catch (error) {
    console.error('[MealPlans] Delete plan error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to delete meal plan'
    });
  }
});

// POST /api/meal-plans/:id/complete - Mark meal as cooked and log to meal_logs
router.post('/:id/complete', authMiddleware.authenticateToken, async (req, res) => {
  try {
    const userId = req.user?.userId || req.user?.id;
    const { id } = req.params;

    console.log(`[MealPlans] Completing plan ${id} for user ${userId}`);

    // Fetch the meal plan with recipe details
    const { data: plan, error: fetchError } = await supabase
      .from('meal_plans')
      .select(`
        *,
        recipe:saved_recipes(id, title, image, extendedIngredients)
      `)
      .eq('id', id)
      .single();

    if (fetchError || !plan) {
      return res.status(404).json({
        success: false,
        error: 'Meal plan not found'
      });
    }

    if (plan.user_id !== userId) {
      return res.status(403).json({
        success: false,
        error: 'Not authorized to complete this meal plan'
      });
    }

    // Create a meal log entry
    const mealLogData = {
      user_id: userId,
      meal_type: plan.meal_type,
      meal_photo_url: plan.recipe?.image || plan.recipe_snapshot?.image || null,
      ingredients_logged: plan.recipe?.extendedIngredients || [],
      logged_at: new Date().toISOString(),
      created_at: new Date().toISOString()
    };

    const { data: mealLog, error: logError } = await supabase
      .from('meal_logs')
      .insert(mealLogData)
      .select()
      .single();

    if (logError) {
      console.error('[MealPlans] Meal log creation error:', logError);
      throw logError;
    }

    // Update the meal plan as completed
    const { data: updatedPlan, error: updateError } = await supabase
      .from('meal_plans')
      .update({
        is_completed: true,
        completed_at: new Date().toISOString(),
        meal_log_id: mealLog.id,
        updated_at: new Date().toISOString()
      })
      .eq('id', id)
      .select()
      .single();

    if (updateError) {
      console.error('[MealPlans] Complete update error:', updateError);
      throw updateError;
    }

    console.log(`[MealPlans] Plan completed and logged:`, { planId: id, mealLogId: mealLog.id });

    res.json({
      success: true,
      plan: updatedPlan,
      mealLog: mealLog,
      message: 'Meal completed and logged to history'
    });

  } catch (error) {
    console.error('[MealPlans] Complete plan error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to complete meal plan'
    });
  }
});

module.exports = router;
