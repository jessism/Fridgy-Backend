const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/auth');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// POST /api/saved-recipes - Create a new saved recipe
router.post('/', authMiddleware.authenticateToken, async (req, res) => {
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

      // Match RecipeDetailModal structure - Use quoted names for PostgreSQL
      '"extendedIngredients"': recipeData.extendedIngredients || [],
      '"analyzedInstructions"': recipeData.analyzedInstructions || [],

      // Time and servings - Use quoted names for case-sensitive columns
      '"readyInMinutes"': recipeData.readyInMinutes || null,
      '"cookingMinutes"': recipeData.cookingMinutes || null,
      servings: recipeData.servings || 4,

      // Dietary attributes - Use quoted names for case-sensitive columns
      vegetarian: recipeData.vegetarian || false,
      vegan: recipeData.vegan || false,
      '"glutenFree"': recipeData.glutenFree || false,
      '"dairyFree"': recipeData.dairyFree || false,

      // Metadata - Use quoted names for case-sensitive columns
      cuisines: recipeData.cuisines || [],
      '"dishTypes"': recipeData.dishTypes || [],

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
    const updates = req.body;
    
    console.log(`[SavedRecipes] Updating recipe ${id} for user ${userId}`);
    
    // Mark as user edited
    updates.user_edited = true;
    updates.updated_at = new Date().toISOString();
    
    // Ensure we're not changing the user_id
    delete updates.user_id;
    delete updates.id;
    
    const { data, error } = await supabase
      .from('saved_recipes')
      .update(updates)
      .eq('id', id)
      .eq('user_id', userId)
      .select()
      .single();
    
    if (error) {
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
    
    const { error } = await supabase
      .from('saved_recipes')
      .delete()
      .eq('id', id)
      .eq('user_id', userId);
    
    if (error) throw error;
    
    res.json({ success: true, message: 'Recipe deleted successfully' });
    
  } catch (error) {
    console.error('[SavedRecipes] Delete error:', error);
    res.status(500).json({ error: 'Failed to delete recipe' });
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