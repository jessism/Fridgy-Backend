const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/auth');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

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
        recipe:saved_recipes(id, title, image, readyInMinutes, source_type, extendedIngredients, analyzedInstructions)
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
    const { recipe_id, recipe_source, recipe_snapshot } = req.body;

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
        error: 'Not authorized to delete this meal plan'
      });
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
