const { getServiceClient } = require('../config/supabase');
const inventoryDeductionService = require('../services/inventoryDeductionService');
const { COOK_SOURCES } = require('../services/insightsConstants');
const { invalidateInsights } = require('../services/insightsService');

// Items expiring within this many days count as "rescued" when a cook uses them.
const RESCUE_WINDOW_DAYS = 3;
// A second identical completion inside this window is a double-tap / retry.
const DEDUPE_WINDOW_MS = 60 * 1000;

const toInt = (v) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n >= 0 ? n : null;
};

const normaliseIngredients = (list) => {
  if (!Array.isArray(list)) return null;
  const cleaned = list
    .map((i) => (typeof i === 'string' ? { name: i } : i))
    .filter((i) => i && typeof i.name === 'string' && i.name.trim())
    .slice(0, 60)
    .map((i) => ({
      name: i.name.trim().slice(0, 120),
      amount: i.amount ?? i.quantity ?? null,
      unit: typeof i.unit === 'string' ? i.unit.slice(0, 30) : null,
    }));
  return cleaned.length ? cleaned : null;
};

// How many distinct live items that expire soon does this recipe use?
// Reuses the deduction matcher so "chicken" ↔ "chicken thighs" resolves the
// same way it does when a meal is logged.
async function countRescuedItems(supabase, userId, ingredients) {
  if (!ingredients?.length) return 0;

  const horizon = new Date(Date.now() + RESCUE_WINDOW_DAYS * 86400000).toISOString().slice(0, 10);
  const { data: expiring, error } = await supabase
    .from('fridge_items')
    .select('*')
    .eq('user_id', userId)
    .is('deleted_at', null)
    .not('expiration_date', 'is', null)
    .lte('expiration_date', horizon);

  if (error || !expiring?.length) return 0;

  const rescued = new Set();
  for (const ingredient of ingredients) {
    try {
      const match = await inventoryDeductionService.findBestMatchWithScore(ingredient, expiring, userId);
      if (match?.item?.id) rescued.add(match.item.id);
    } catch (_) {
      // matcher problems must never fail the event
    }
  }
  return rescued.size;
}

const cookEventsController = {
  async createCookEvent(req, res) {
    const requestId = Math.random().toString(36).substring(7);
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ success: false, error: 'Authentication required' });

      const body = req.body || {};
      const recipeName = (typeof body.recipeName === 'string' && body.recipeName.trim().slice(0, 200)) || 'Untitled recipe';
      const recipeId = typeof body.recipeId === 'string' && body.recipeId.trim() ? body.recipeId.trim() : null;
      let recipeSource = COOK_SOURCES.includes(body.recipeSource) ? body.recipeSource : (recipeId ? 'saved' : 'unsaved');
      const ingredients = normaliseIngredients(body.ingredientsUsed);
      const supabase = getServiceClient();

      // Dedupe: same recipe completed again within a minute → return the existing row.
      const nameKey = recipeName.trim().toLowerCase();
      const since = new Date(Date.now() - DEDUPE_WINDOW_MS).toISOString();
      const { data: recent } = await supabase
        .from('cook_events')
        .select('*')
        .eq('user_id', userId)
        .eq('recipe_name_key', nameKey)
        .gte('cooked_at', since)
        .order('cooked_at', { ascending: false })
        .limit(1);
      if (recent?.length) {
        return res.json({ success: true, data: recent[0], deduplicated: true, requestId });
      }

      // Enrich from the saved recipe when we have one the user owns; bump its
      // counter so times_cooked and cook_events never diverge.
      let cuisines = [];
      if (recipeId) {
        const { data: saved } = await supabase
          .from('saved_recipes')
          .select('id, cuisines, times_cooked')
          .eq('id', recipeId)
          .eq('user_id', userId)
          .maybeSingle();
        if (saved) {
          cuisines = Array.isArray(saved.cuisines) ? saved.cuisines : [];
          await supabase
            .from('saved_recipes')
            .update({
              times_cooked: (saved.times_cooked || 0) + 1,
              last_cooked: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            })
            .eq('id', recipeId)
            .eq('user_id', userId);
        } else {
          // Not theirs / gone — keep the event, drop the dangling reference.
          recipeSource = recipeSource === 'saved' ? 'unsaved' : recipeSource;
        }
      }

      const itemsRescued = await countRescuedItems(supabase, userId, ingredients);

      const { data: row, error } = await supabase
        .from('cook_events')
        .insert({
          user_id: userId,
          recipe_id: recipeId && recipeSource !== 'unsaved' ? recipeId : null,
          recipe_source: recipeSource,
          recipe_name: recipeName,
          cuisines,
          ingredients_used: ingredients,
          items_rescued_count: itemsRescued,
          servings: toInt(body.servings),
          step_count: toInt(body.stepCount),
          duration_seconds: toInt(body.durationSeconds),
        })
        .select('*')
        .single();

      if (error) throw error;

      invalidateInsights(userId);
      res.status(201).json({ success: true, data: row, requestId });
    } catch (error) {
      console.error(`💥 [${requestId}] cook-events insert failed:`, error.message);
      res.status(500).json({ success: false, error: 'Failed to record cook event', requestId });
    }
  },
};

module.exports = cookEventsController;
