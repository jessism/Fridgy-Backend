const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/auth');
const { checkUploadedRecipeLimit, incrementUsageCounter, decrementUsageCounter } = require('../middleware/checkLimits');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY
);

// POST /api/saved-recipes - Create a new saved recipe
router.post('/', authMiddleware.authenticateToken, checkUploadedRecipeLimit, async (req, res) => {
  try {
    const userId = req.user?.userId || req.user?.id;
    const recipeData = req.body;

    console.log(`[SavedRecipes] Creating new recipe for user ${userId}`);
    console.log(`[SavedRecipes] Recipe title: ${recipeData.title}`);
    console.log(`[SavedRecipes] Source type: ${recipeData.source_type || 'manual'}`);

    // Prepare recipe data for database
    const newRecipe = {
      user_id: userId,
      source_type: recipeData.source_type || 'manual',
      title: recipeData.title || 'Untitled Recipe',
      summary: recipeData.summary || recipeData.description || '',
      image: recipeData.image || null,

      // Match RecipeDetailModal structure - camelCase columns
      extendedIngredients: recipeData.extendedIngredients || [],
      analyzedInstructions: recipeData.analyzedInstructions || [],

      // Time and servings - camelCase columns
      readyInMinutes: recipeData.readyInMinutes || null,
      cookingMinutes: recipeData.cookingMinutes || null,
      servings: recipeData.servings || 4,

      // Dietary attributes - camelCase columns
      vegetarian: recipeData.vegetarian || false,
      vegan: recipeData.vegan || false,
      glutenFree: recipeData.glutenFree || false,
      dairyFree: recipeData.dairyFree || false,

      // Metadata - camelCase columns
      cuisines: recipeData.cuisines || [],
      dishTypes: recipeData.dishTypes || [],

      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };

    // Save to database
    const { data, error } = await supabase
      .from('saved_recipes')
      .insert(newRecipe)
      .select()
      .single();

    if (error) {
      console.error('[SavedRecipes] Create error:', error);
      throw error;
    }

    console.log(`[SavedRecipes] Recipe created successfully with ID: ${data.id}`);

    // Increment usage counter
    await incrementUsageCounter(userId, 'uploaded_recipes');
    console.log(`[SavedRecipes] Usage counter incremented for user ${userId}`);

    res.json({
      success: true,
      recipe: data,
      message: 'Recipe saved successfully'
    });

  } catch (error) {
    console.error('[SavedRecipes] Create recipe error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to save recipe'
    });
  }
});

// GET /api/saved-recipes/:id/public - Public recipe view (NO AUTH REQUIRED)
// Used for Messenger "Open in Trackabite" button - shows full recipe without login
router.get('/:id/public', async (req, res) => {
  try {
    const { id } = req.params;

    console.log(`[SavedRecipes] Public recipe request for ID: ${id}`);

    const { data: recipe, error } = await supabase
      .from('saved_recipes')
      .select('*')
      .eq('id', id)
      .single();

    if (error || !recipe) {
      console.log(`[SavedRecipes] Public recipe not found: ${id}`);
      return res.status(404).json({ error: 'Recipe not found' });
    }

    console.log(`[SavedRecipes] Public recipe found: ${recipe.title}`);

    // Return recipe data (exclude user_id for privacy)
    res.json({
      id: recipe.id,
      title: recipe.title,
      summary: recipe.summary,
      image: recipe.image,
      extendedIngredients: recipe.extendedIngredients,
      analyzedInstructions: recipe.analyzedInstructions,
      readyInMinutes: recipe.readyInMinutes,
      servings: recipe.servings,
      source_author: recipe.source_author,
      source_type: recipe.source_type,
      source_url: recipe.source_url,
      nutrition: recipe.nutrition,
      vegetarian: recipe.vegetarian,
      vegan: recipe.vegan,
      glutenFree: recipe.glutenFree,
      dairyFree: recipe.dairyFree,
      cuisines: recipe.cuisines,
      dishTypes: recipe.dishTypes
    });

  } catch (error) {
    console.error('[SavedRecipes] Public recipe error:', error);
    res.status(500).json({ error: 'Failed to fetch recipe' });
  }
});

// GET /api/saved-recipes - Get user's saved recipes
router.get('/', authMiddleware.authenticateToken, async (req, res) => {
  try {
    const userId = req.user?.userId || req.user?.id;
    const { 
      limit = 20, 
      offset = 0, 
      filter = 'all',
      search = ''
    } = req.query;
    
    console.log(`[SavedRecipes] Fetching recipes for user ${userId}, filter: ${filter}`);
    
    let query = supabase
      .from('saved_recipes')
      .select('*', { count: 'exact' })
      .eq('user_id', userId)
      .order('created_at', { ascending: false });
    
    // Apply filters
    if (filter === 'favorites') {
      query = query.eq('is_favorite', true);
    } else if (filter === 'instagram') {
      query = query.eq('source_type', 'instagram');
    } else if (filter === 'scanned') {
      query = query.eq('source_type', 'scanned');
    } else if (filter === 'edited') {
      query = query.eq('user_edited', true);
    } else if (filter === 'imported') {
      // Filter for imported recipes (exclude manual/uploaded)
      query = query.neq('source_type', 'manual')
                   .neq('import_method', 'manual')
                   .neq('source_author', 'Me');
    } else if (filter === 'uploaded') {
      // Filter for uploaded/manual recipes
      query = query.or('source_type.eq.manual,import_method.eq.manual,source_author.eq.Me,source_type.eq.scanned,source_type.eq.voice,source_type.eq.user_created');
    }

    // Search by title or tags
    if (search) {
      query = query.or(`title.ilike.%${search}%,cuisines.cs.{${search}},dishTypes.cs.{${search}}`);
    }
    
    // Apply pagination
    query = query.range(parseInt(offset), parseInt(offset) + parseInt(limit) - 1);
    
    const { data, error, count } = await query;
    
    if (error) throw error;
    
    console.log(`[SavedRecipes] Found ${data?.length || 0} recipes`);

    // Debug: Log image URLs for uploaded/manual recipes
    const uploadedRecipes = (data || []).filter(recipe => {
      const sourceType = recipe.source_type?.toLowerCase();
      return sourceType === 'manual' ||
             recipe.import_method === 'manual' ||
             recipe.source_author === 'Me';
    });

    if (uploadedRecipes.length > 0) {
      console.log('[SavedRecipes] Checking image URLs in uploaded recipes:');
      uploadedRecipes.forEach(recipe => {
        console.log(`[SavedRecipes] Recipe "${recipe.title}":`, {
          id: recipe.id,
          hasImage: !!recipe.image,
          imageUrl: recipe.image || 'NO IMAGE'
        });
      });
    }

    res.json({
      recipes: data || [],
      total: count || 0,
      limit: parseInt(limit),
      offset: parseInt(offset)
    });
    
  } catch (error) {
    console.error('[SavedRecipes] Fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch recipes' });
  }
});

// GET /api/saved-recipes/:id - Get single recipe
router.get('/:id', authMiddleware.authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user?.userId || req.user?.id;
    
    console.log(`[SavedRecipes] Fetching recipe ${id} for user ${userId}`);
    
    const { data, error } = await supabase
      .from('saved_recipes')
      .select('*')
      .eq('id', id)
      .eq('user_id', userId)
      .single();
    
    if (error) {
      if (error.code === 'PGRST116') {
        return res.status(404).json({ error: 'Recipe not found' });
      }
      throw error;
    }
    
    res.json(data);
    
  } catch (error) {
    console.error('[SavedRecipes] Fetch single error:', error);
    res.status(500).json({ error: 'Failed to fetch recipe' });
  }
});

// PUT /api/saved-recipes/:id - Update recipe
router.put('/:id', authMiddleware.authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user?.userId || req.user?.id;
    const body = req.body;

    console.log(`[SavedRecipes] Updating recipe ${id} for user ${userId}`);

    // Whitelist only valid database columns to prevent errors from frontend-only fields
    const allowedFields = [
      'title', 'summary', 'image', 'image_urls',
      'extendedIngredients', 'analyzedInstructions',
      'readyInMinutes', 'cookingMinutes', 'servings',
      'vegetarian', 'vegan', 'glutenFree', 'dairyFree',
      'veryHealthy', 'cheap', 'veryPopular',
      'cuisines', 'dishTypes', 'diets', 'occasions',
      'nutrition', 'user_notes', 'rating', 'is_favorite',
      'source_type', 'source_url', 'source_author'
    ];

    const updates = {};
    for (const field of allowedFields) {
      if (body[field] !== undefined) {
        updates[field] = body[field];
      }
    }

    // Mark as user edited
    updates.user_edited = true;
    updates.updated_at = new Date().toISOString();

    const { data, error } = await supabase
      .from('saved_recipes')
      .update(updates)
      .eq('id', id)
      .eq('user_id', userId)
      .select()
      .single();

    if (error) {
      console.error('[SavedRecipes] Supabase error:', error);
      if (error.code === 'PGRST116') {
        return res.status(404).json({ error: 'Recipe not found' });
      }
      throw error;
    }

    res.json(data);

  } catch (error) {
    console.error('[SavedRecipes] Update error:', error);
    res.status(500).json({ error: 'Failed to update recipe' });
  }
});

// DELETE /api/saved-recipes/:id - Delete recipe
router.delete('/:id', authMiddleware.authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user?.userId || req.user?.id;

    console.log(`[SavedRecipes] Deleting recipe ${id} for user ${userId}`);

    // Get recipe first to know its source_type for usage decrement
    const { data: recipe } = await supabase
      .from('saved_recipes')
      .select('source_type')
      .eq('id', id)
      .eq('user_id', userId)
      .single();

    const { error } = await supabase
      .from('saved_recipes')
      .delete()
      .eq('id', id)
      .eq('user_id', userId);

    if (error) throw error;

    // Decrement appropriate counter based on source_type
    if (recipe?.source_type === 'instagram') {
      await decrementUsageCounter(userId, 'imported_recipes');
    } else {
      await decrementUsageCounter(userId, 'uploaded_recipes');
    }
    console.log(`[SavedRecipes] Usage counter decremented`);

    res.json({ success: true, message: 'Recipe deleted successfully' });
    
  } catch (error) {
    console.error('[SavedRecipes] Delete error:', error);
    res.status(500).json({ error: 'Failed to delete recipe' });
  }
});

// POST /api/saved-recipes/from-ai - Save AI recipe as favorite
router.post('/from-ai', authMiddleware.authenticateToken, async (req, res) => {
  try {
    const userId = req.user?.userId || req.user?.id;
    const aiRecipe = req.body;

    console.log(`[SavedRecipes] Saving AI recipe as favorite for user ${userId}`);
    console.log(`[SavedRecipes] AI Recipe title: ${aiRecipe.title}`);

    // Map AI recipe fields to saved_recipes schema
    const newRecipe = {
      user_id: userId,
      source_type: 'ai_generated',
      is_favorite: true,
      title: aiRecipe.title,
      summary: aiRecipe.description || '',
      image: aiRecipe._imageUrl || aiRecipe.image || null,
      extendedIngredients: aiRecipe.ingredients?.map(ing => ({
        original: `${ing.amount} ${ing.item}`,
        name: ing.item,
        amount: ing.amount
      })) || [],
      analyzedInstructions: [{
        steps: aiRecipe.instructions?.map((step, i) => ({
          number: i + 1,
          step: step
        })) || []
      }],
      readyInMinutes: parseInt(aiRecipe.total_time) || null,
      servings: aiRecipe.servings || 4,
      vegetarian: aiRecipe.dietary_info?.vegetarian || false,
      vegan: aiRecipe.dietary_info?.vegan || false,
      glutenFree: aiRecipe.dietary_info?.gluten_free || false,
      dairyFree: aiRecipe.dietary_info?.dairy_free || false,
      cuisines: aiRecipe.cuisine_type ? [aiRecipe.cuisine_type] : [],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };

    const { data, error } = await supabase
      .from('saved_recipes')
      .insert(newRecipe)
      .select()
      .single();

    if (error) {
      console.error('[SavedRecipes] Insert error:', error);
      throw error;
    }

    console.log(`[SavedRecipes] AI recipe saved successfully with ID: ${data.id}`);
    res.json({ success: true, recipe: data });

  } catch (error) {
    console.error('[SavedRecipes] Save AI recipe error:', error);
    res.status(500).json({ error: 'Failed to save AI recipe' });
  }
});

// POST /api/saved-recipes/:id/favorite - Toggle favorite
router.post('/:id/favorite', authMiddleware.authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user?.userId || req.user?.id;
    
    console.log(`[SavedRecipes] Toggling favorite for recipe ${id}`);
    
    // Get current state
    const { data: current, error: fetchError } = await supabase
      .from('saved_recipes')
      .select('is_favorite')
      .eq('id', id)
      .eq('user_id', userId)
      .single();
    
    if (fetchError) {
      if (fetchError.code === 'PGRST116') {
        return res.status(404).json({ error: 'Recipe not found' });
      }
      throw fetchError;
    }
    
    // Toggle
    const { data, error } = await supabase
      .from('saved_recipes')
      .update({ 
        is_favorite: !current.is_favorite,
        updated_at: new Date().toISOString()
      })
      .eq('id', id)
      .eq('user_id', userId)
      .select()
      .single();
    
    if (error) throw error;
    
    res.json(data);
    
  } catch (error) {
    console.error('[SavedRecipes] Toggle favorite error:', error);
    res.status(500).json({ error: 'Failed to update favorite' });
  }
});

// POST /api/saved-recipes/:id/cook - Mark recipe as cooked
router.post('/:id/cook', authMiddleware.authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user?.userId || req.user?.id;
    
    console.log(`[SavedRecipes] Marking recipe ${id} as cooked`);
    
    // Get current recipe
    const { data: recipe, error: fetchError } = await supabase
      .from('saved_recipes')
      .select('times_cooked')
      .eq('id', id)
      .eq('user_id', userId)
      .single();
    
    if (fetchError) {
      if (fetchError.code === 'PGRST116') {
        return res.status(404).json({ error: 'Recipe not found' });
      }
      throw fetchError;
    }
    
    // Update times cooked
    const { data, error } = await supabase
      .from('saved_recipes')
      .update({ 
        times_cooked: (recipe.times_cooked || 0) + 1,
        last_cooked: new Date().toISOString(),
        updated_at: new Date().toISOString()
      })
      .eq('id', id)
      .eq('user_id', userId)
      .select()
      .single();
    
    if (error) throw error;
    
    res.json(data);
    
  } catch (error) {
    console.error('[SavedRecipes] Mark cooked error:', error);
    res.status(500).json({ error: 'Failed to mark recipe as cooked' });
  }
});

// GET /api/saved-recipes/collections - Get user's collections
router.get('/collections', authMiddleware.authenticateToken, async (req, res) => {
  try {
    const userId = req.user?.userId || req.user?.id;
    
    console.log(`[SavedRecipes] Fetching collections for user ${userId}`);
    
    const { data, error } = await supabase
      .from('recipe_collections')
      .select('*')
      .eq('user_id', userId)
      .order('sort_order', { ascending: true });
    
    if (error) throw error;
    
    res.json(data || []);
    
  } catch (error) {
    console.error('[SavedRecipes] Fetch collections error:', error);
    res.status(500).json({ error: 'Failed to fetch collections' });
  }
});

// POST /api/saved-recipes/collections - Create collection
router.post('/collections', authMiddleware.authenticateToken, async (req, res) => {
  try {
    const userId = req.user?.userId || req.user?.id;
    const { name, description, icon, color } = req.body;
    
    console.log(`[SavedRecipes] Creating collection for user ${userId}`);
    
    if (!name) {
      return res.status(400).json({ error: 'Collection name is required' });
    }
    
    const { data, error } = await supabase
      .from('recipe_collections')
      .insert({
        user_id: userId,
        name,
        description,
        icon: icon || '📁',
        color: color || '#4fcf61'
      })
      .select()
      .single();
    
    if (error) throw error;
    
    res.json(data);
    
  } catch (error) {
    console.error('[SavedRecipes] Create collection error:', error);
    res.status(500).json({ error: 'Failed to create collection' });
  }
});

// POST /api/saved-recipes/:id/collections/:collectionId - Add recipe to collection
router.post('/:id/collections/:collectionId', authMiddleware.authenticateToken, async (req, res) => {
  try {
    const { id, collectionId } = req.params;
    const userId = req.user?.userId || req.user?.id;
    
    console.log(`[SavedRecipes] Adding recipe ${id} to collection ${collectionId}`);
    
    // Verify both recipe and collection belong to user
    const { data: recipe } = await supabase
      .from('saved_recipes')
      .select('id')
      .eq('id', id)
      .eq('user_id', userId)
      .single();
    
    const { data: collection } = await supabase
      .from('recipe_collections')
      .select('id')
      .eq('id', collectionId)
      .eq('user_id', userId)
      .single();
    
    if (!recipe || !collection) {
      return res.status(404).json({ error: 'Recipe or collection not found' });
    }
    
    // Add to collection
    const { error } = await supabase
      .from('recipe_collection_items')
      .insert({
        collection_id: collectionId,
        recipe_id: id
      });
    
    if (error) {
      if (error.code === '23505') { // Unique violation
        return res.status(400).json({ error: 'Recipe already in collection' });
      }
      throw error;
    }
    
    res.json({ success: true, message: 'Recipe added to collection' });
    
  } catch (error) {
    console.error('[SavedRecipes] Add to collection error:', error);
    res.status(500).json({ error: 'Failed to add recipe to collection' });
  }
});

module.exports = router;