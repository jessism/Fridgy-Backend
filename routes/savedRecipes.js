const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/auth');
const { checkSavedRecipeLimit, incrementUsageCounter } = require('../middleware/checkLimits');
const { generateRecipeTags } = require('../services/recipeTagService');
const streakService = require('../services/streakService');
const { getServiceClient } = require('../config/supabase');
const { publicShareLimiter, shareMutationLimiter } = require('../middleware/rateLimiter');
const recipeShare = require('../services/recipeShareService');

const supabase = getServiceClient();

// POST /api/saved-recipes - Create a new saved recipe
router.post('/', authMiddleware.authenticateToken, checkSavedRecipeLimit, async (req, res) => {
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
      source_author: recipeData.source_author || null,
      source_url: recipeData.source_url || null,
      source_author_image: recipeData.source_author_image || null,
      title: recipeData.title || 'Untitled Recipe',
      summary: recipeData.summary || recipeData.description || '',
      image: recipeData.image || null,
      image_urls: recipeData.image_urls || null,
      nutrition: recipeData.nutrition || null,

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

    // Generate AI tags for the recipe
    const aiTags = generateRecipeTags(newRecipe);
    console.log(`[SavedRecipes] Generated ${aiTags.length} AI tags:`, aiTags.map(t => t.name).join(', '));
    newRecipe.tags = aiTags;

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

    // Increment usage counter (all recipe saves count toward weekly limit)
    await incrementUsageCounter(userId, 'saved_recipes');
    console.log(`[SavedRecipes] Saved recipes counter incremented for user ${userId}`);

    res.json({
      success: true,
      recipe: data,
      message: 'Recipe saved successfully'
    });

    // Streak: fire-and-forget
    streakService.recordAction(userId, 'recipe_save').catch(err => {
      console.error('[Streak] Failed to record recipe_save:', err.message);
    });

  } catch (error) {
    console.error('[SavedRecipes] Create recipe error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to save recipe'
    });
  }
});

// POST /api/saved-recipes/adopt/:sourceId - Take a copy of a public-source recipe
// Backs the Home "Suggested Meal" card: opening a community suggestion makes it the
// user's own, so they can note/edit/cook it without touching the original.
//
// Deliberately NOT behind checkSavedRecipeLimit and it does NOT increment the
// saved_recipes counter. Adopting costs ~5KB and no API spend (the image is
// referenced by URL, never duplicated), so the weekly cap stays reserved for
// Instagram/web/manual imports, which is the behaviour it was built around.
router.post('/adopt/:sourceId', authMiddleware.authenticateToken, async (req, res) => {
  try {
    const userId = req.user?.userId || req.user?.id;
    const { sourceId } = req.params;

    console.log(`[SavedRecipes] Adopt request: source ${sourceId} for user ${userId}`);

    const { data: source, error: sourceError } = await supabase
      .from('saved_recipes')
      .select('*')
      .eq('id', sourceId)
      .single();

    if (sourceError || !source) {
      console.log(`[SavedRecipes] Adopt: source not found ${sourceId}`);
      return res.status(404).json({ success: false, error: 'Recipe not found' });
    }

    // Security boundary: only publicly-sourced recipes may be copied between
    // users. manual/scanned/voice/user_created rows are the owner's own content
    // — family recipes, handwritten cards, dictated notes — and nobody consented
    // to those being handed to a stranger who guessed a UUID.
    // A recipe the owner explicitly shared (visibility='public', /r/<slug>)
    // is also fair game: "Save to my recipes" on a shared link lands here.
    if (!recipeShare.PUBLIC_SOURCES.includes(source.source_type) && source.visibility !== 'public') {
      console.warn(`[SavedRecipes] Adopt refused: ${sourceId} is source_type '${source.source_type}'`);
      return res.status(403).json({ success: false, error: 'This recipe cannot be copied' });
    }

    // Already adopted? Return that row rather than piling up duplicates on
    // repeat taps. Matches the pool's dedupe key: source_url, else title+author.
    let existingQuery = supabase.from('saved_recipes').select('*').eq('user_id', userId);
    existingQuery = source.source_url
      ? existingQuery.eq('source_url', source.source_url)
      : existingQuery.ilike('title', source.title || '');

    const { data: existing } = await existingQuery.limit(1);
    if (existing && existing.length > 0) {
      console.log(`[SavedRecipes] Adopt: user already owns a copy (${existing[0].id})`);
      return res.json({ success: true, recipe: existing[0], adopted: false });
    }

    // Copy the recipe content; drop everything personal to the original owner.
    const {
      id: _id, user_id: _userId, created_at: _createdAt, updated_at: _updatedAt,
      user_notes: _notes, user_notes_updated_at: _notesAt, rating: _rating,
      times_cooked: _cooked, last_cooked: _lastCooked, is_favorite: _fav,
      user_edited: _edited,
      // Belongs to the original owner, not the copy: their Google Drive sync
      // state, the storage object they own, and a sharing setting this user
      // never chose. Carrying any of these across accounts would be a leak.
      drive_file_id: _driveId, drive_synced_at: _driveAt, drive_sync_status: _driveStatus,
      image_storage_path: _storagePath, visibility: _visibility,
      // The share link is the original owner's too (unique index on share_slug
      // would reject the copy outright).
      share_slug: _shareSlug, shared_at: _sharedAt,
      ...content
    } = source;

    const copy = {
      ...content,
      user_id: userId,
      times_cooked: 0,
      is_favorite: false,
      user_edited: false,
      // Marks this as taken from the Home suggestion card so that card can stop
      // re-suggesting it as "your most recent save". Set after the spread so a
      // source that was itself adopted doesn't pass its own pointer along.
      adopted_from: sourceId,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };

    const { data, error } = await supabase
      .from('saved_recipes')
      .insert(copy)
      .select()
      .single();

    if (error) {
      console.error('[SavedRecipes] Adopt insert error:', error);
      throw error;
    }

    console.log(`[SavedRecipes] Adopted ${sourceId} -> ${data.id} for user ${userId}`);
    res.json({ success: true, recipe: data, adopted: true });

  } catch (error) {
    console.error('[SavedRecipes] Adopt error:', error);
    res.status(500).json({ success: false, error: 'Failed to save recipe' });
  }
});

// ===== Share links (/r/<slug>) =====
// Declared above /:id/public and /:id — Express matches in declaration order.

// GET /api/saved-recipes/share/:slug - Public read by share slug (NO AUTH)
// 404: no such slug. 410: slug exists but the owner turned sharing off (the
// slug is kept so re-sharing yields the same URL; 410 is also the fastest
// "drop it" signal for anything that cached the link).
router.get('/share/:slug', publicShareLimiter, async (req, res) => {
  try {
    const { slug } = req.params;
    if (!recipeShare.isValidSlug(slug)) {
      return res.status(404).json({ error: 'Recipe not found' });
    }

    const { data: recipe, error } = await supabase
      .from('saved_recipes')
      .select('*')
      .eq('share_slug', slug)
      .maybeSingle();

    if (error) throw error;
    if (!recipe) {
      return res.status(404).json({ error: 'Recipe not found' });
    }
    if (recipe.visibility !== 'public') {
      return res.status(410).json({ error: 'This recipe is no longer shared', code: 'UNSHARED' });
    }

    const [ownerName, og] = await Promise.all([
      recipeShare.lookupOwnerName(recipe.user_id),
      recipeShare.buildOgImage(recipe),
    ]);

    res.set('Cache-Control', 'public, max-age=60');
    res.json(recipeShare.toPublicRecipe(recipe, {
      slug,
      shared_at: recipe.shared_at,
      owner: { displayName: ownerName },
      ...og,
    }));
  } catch (error) {
    console.error('[SavedRecipes] Share read error:', error);
    res.status(500).json({ error: 'Failed to fetch recipe' });
  }
});

// POST /api/saved-recipes/:id/share - Turn sharing on (idempotent)
router.post('/:id/share', authMiddleware.authenticateToken, shareMutationLimiter, async (req, res) => {
  try {
    const userId = req.user?.userId || req.user?.id;
    const { id } = req.params;

    // popular-* pseudo-ids and garbage would otherwise reach Postgres as a
    // uuid cast error (22P02) and surface as a 500.
    if (!recipeShare.isUuid(id)) {
      return res.status(403).json({ success: false, error: 'This recipe cannot be shared', code: 'NOT_SHAREABLE' });
    }

    const { data: recipe, error } = await supabase
      .from('saved_recipes')
      .select('*')
      .eq('id', id)
      .eq('user_id', userId)
      .maybeSingle();

    if (error) throw error;
    if (!recipe) {
      return res.status(404).json({ success: false, error: 'Recipe not found' });
    }
    if (!recipeShare.isShareable(recipe)) {
      return res.status(403).json({
        success: false,
        error: 'Add at least one ingredient and one step before sharing',
        code: 'NOT_SHAREABLE',
      });
    }

    const now = new Date().toISOString();
    let slug = recipe.share_slug;
    let sharedAt = recipe.visibility === 'public' && recipe.shared_at ? recipe.shared_at : now;

    if (!slug) {
      // Two devices tapping Share at once race on the unique index; the loser
      // re-reads and takes the winner's slug.
      for (let attempt = 0; attempt < 2 && !slug; attempt++) {
        const candidate = recipeShare.mintSlug(recipe.title);
        const { error: writeError } = await supabase
          .from('saved_recipes')
          .update({ share_slug: candidate, visibility: 'public', shared_at: now, updated_at: now })
          .eq('id', id)
          .eq('user_id', userId)
          .is('share_slug', null);

        if (!writeError) {
          slug = candidate;
        } else if (writeError.code === '23505') {
          continue; // token collision (astronomically rare) — mint again
        } else {
          throw writeError;
        }

        if (slug) {
          // .is('share_slug', null) matched nothing if another request won.
          const { data: fresh } = await supabase
            .from('saved_recipes')
            .select('share_slug, shared_at')
            .eq('id', id)
            .single();
          slug = fresh?.share_slug || slug;
          sharedAt = fresh?.shared_at || now;
        }
      }
      if (!slug) throw new Error('Could not mint a share slug');
    } else if (recipe.visibility !== 'public') {
      const { error: writeError } = await supabase
        .from('saved_recipes')
        .update({ visibility: 'public', shared_at: now, updated_at: now })
        .eq('id', id)
        .eq('user_id', userId);
      if (writeError) throw writeError;
      sharedAt = now;
    }

    // Best-effort: re-host an expiring CDN image so the preview card survives.
    const image = await recipeShare.ensureDurableImage({ ...recipe, share_slug: slug });

    console.log(`[SavedRecipes] Shared ${id} as /r/${slug} for user ${userId}`);
    res.json({
      success: true,
      slug,
      url: recipeShare.buildShareUrl(slug),
      shared_at: sharedAt,
      visibility: 'public',
      image: image || recipe.image,
    });
  } catch (error) {
    console.error('[SavedRecipes] Share error:', error);
    res.status(500).json({ success: false, error: 'Failed to share recipe' });
  }
});

// DELETE /api/saved-recipes/:id/share - Turn sharing off. Keeps the slug.
router.delete('/:id/share', authMiddleware.authenticateToken, shareMutationLimiter, async (req, res) => {
  try {
    const userId = req.user?.userId || req.user?.id;
    const { id } = req.params;

    if (!recipeShare.isUuid(id)) {
      return res.status(404).json({ success: false, error: 'Recipe not found' });
    }

    const { data, error } = await supabase
      .from('saved_recipes')
      .update({ visibility: 'private', shared_at: null, updated_at: new Date().toISOString() })
      .eq('id', id)
      .eq('user_id', userId)
      .select('id')
      .maybeSingle();

    if (error) throw error;
    if (!data) {
      return res.status(404).json({ success: false, error: 'Recipe not found' });
    }

    console.log(`[SavedRecipes] Unshared ${id} for user ${userId}`);
    res.json({ success: true, visibility: 'private' });
  } catch (error) {
    console.error('[SavedRecipes] Unshare error:', error);
    res.status(500).json({ success: false, error: 'Failed to stop sharing' });
  }
});

// GET /api/saved-recipes/:id/public - Public recipe view (NO AUTH REQUIRED)
// Used by the Messenger/Instagram bots' "Open in Trackabite" links and by the
// mobile app for community-shelf recipes that aren't the viewer's own.
//
// Gated by SOURCE, not by auth: rows imported from public platforms (and
// rows the owner explicitly shared or admins curated) are readable by id;
// manual / voice / scanned / ai_generated recipes are not. 404 either way —
// don't confirm that a private row exists.
router.get('/:id/public', publicShareLimiter, async (req, res) => {
  try {
    const { id } = req.params;

    if (!recipeShare.isUuid(id)) {
      return res.status(404).json({ error: 'Recipe not found' });
    }

    const { data: recipe, error } = await supabase
      .from('saved_recipes')
      .select('*')
      .eq('id', id)
      .maybeSingle();

    if (error) throw error;
    if (!recipe || !recipeShare.isPubliclyReadable(recipe)) {
      console.log(`[SavedRecipes] Public recipe refused/not found: ${id}`);
      return res.status(404).json({ error: 'Recipe not found' });
    }

    res.json(recipeShare.toPublicRecipe(recipe));

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
      'source_type', 'source_url', 'source_author',
      'tags'  // NEW: Recipe tags (AI-generated + custom)
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
    // Server-side stamp so the notes card can show when the note was written
    if (updates.user_notes !== undefined) {
      updates.user_notes_updated_at = updates.updated_at;
    }

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

// PATCH /api/saved-recipes/:id - Partial update recipe (e.g., toggle favorite)
router.patch('/:id', authMiddleware.authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user?.userId || req.user?.id;
    const body = req.body;

    console.log(`[SavedRecipes] Partial update for recipe ${id} by user ${userId}`);
    console.log(`[SavedRecipes] Update fields:`, Object.keys(body));

    // Whitelist allowed fields for partial updates
    const allowedFields = [
      'title', 'summary', 'image', 'image_urls',
      'extendedIngredients', 'analyzedInstructions',
      'readyInMinutes', 'cookingMinutes', 'servings',
      'vegetarian', 'vegan', 'glutenFree', 'dairyFree',
      'veryHealthy', 'cheap', 'veryPopular',
      'cuisines', 'dishTypes', 'diets', 'occasions',
      'nutrition', 'user_notes', 'rating', 'is_favorite',
      'source_type', 'source_url', 'source_author',
      'tags'
    ];

    const updates = {};
    for (const field of allowedFields) {
      if (body[field] !== undefined) {
        updates[field] = body[field];
      }
    }

    // Only set updated_at (don't mark as user_edited for simple toggles like favorite)
    updates.updated_at = new Date().toISOString();
    // Server-side stamp so the notes card can show when the note was written
    if (updates.user_notes !== undefined) {
      updates.user_notes_updated_at = updates.updated_at;
    }

    // If no valid fields provided, return error
    if (Object.keys(updates).length === 1) { // Only updated_at
      return res.status(400).json({ error: 'No valid fields to update' });
    }

    console.log(`[SavedRecipes] Applying updates:`, updates);

    const { data, error } = await supabase
      .from('saved_recipes')
      .update(updates)
      .eq('id', id)
      .eq('user_id', userId)
      .select()
      .single();

    if (error) {
      console.error('[SavedRecipes] Supabase PATCH error:', error);
      if (error.code === 'PGRST116') {
        return res.status(404).json({ error: 'Recipe not found' });
      }
      throw error;
    }

    console.log(`[SavedRecipes] Recipe ${id} updated successfully`);
    res.json(data);

  } catch (error) {
    console.error('[SavedRecipes] Partial update error:', error);
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

    // Intentionally no usage decrement: saved_recipes_count is a weekly RATE
    // limit, not a stock cap, so deleting a recipe does not earn quota back.

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
      is_favorite: false,
      title: aiRecipe.title,
      summary: aiRecipe.description || '',
      image: aiRecipe.imageUrl || aiRecipe._imageUrl || aiRecipe.image || null,
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
      nutrition: aiRecipe.nutrition || null,
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