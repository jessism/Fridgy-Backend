const express = require('express');
const multer = require('multer');
const { authenticateToken } = require('../middleware/auth');
const { requireAdmin } = require('../middleware/adminAuth');
const blogRecipeGenerator = require('../services/blogRecipeGenerator');
const { getServiceClient } = require('../config/supabase');

const router = express.Router();

// Multer for photo uploads (memory storage, 10MB limit)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }
});

// Helper: get supabase client
const getSupabase = () => getServiceClient();

// ============================================================
// PUBLIC ENDPOINTS
// ============================================================

/**
 * GET /api/blog/recipes
 * List all published recipes (for the public blog page)
 */
router.get('/recipes', async (req, res) => {
  try {
    const supabase = getSupabase();
    const { data, error } = await supabase
      .from('blog_recipes')
      .select('id, title, slug, description, image_url, prep_time, cook_time, servings, tags, published_at')
      .eq('status', 'published')
      .order('published_at', { ascending: false });

    if (error) throw error;

    res.json({ success: true, recipes: data || [] });
  } catch (error) {
    console.error('[Blog] Error fetching recipes:', error.message);
    res.status(500).json({ success: false, error: 'Failed to fetch recipes' });
  }
});

/**
 * GET /api/blog/recipes/:slug
 * Get a single published recipe by slug (for individual recipe page)
 */
router.get('/recipes/:slug', async (req, res) => {
  try {
    const supabase = getSupabase();
    const { data, error } = await supabase
      .from('blog_recipes')
      .select('*')
      .eq('slug', req.params.slug)
      .eq('status', 'published')
      .single();

    if (error || !data) {
      return res.status(404).json({ success: false, error: 'Recipe not found' });
    }

    res.json({ success: true, recipe: data });
  } catch (error) {
    console.error('[Blog] Error fetching recipe:', error.message);
    res.status(500).json({ success: false, error: 'Failed to fetch recipe' });
  }
});

/**
 * GET /api/blog/sitemap
 * Return XML sitemap for all published blog recipes
 */
router.get('/sitemap', async (req, res) => {
  try {
    const supabase = getSupabase();
    const { data, error } = await supabase
      .from('blog_recipes')
      .select('slug, published_at, updated_at')
      .eq('status', 'published')
      .order('published_at', { ascending: false });

    if (error) throw error;

    const baseUrl = 'https://www.trackabite.app';
    const urls = (data || []).map(recipe => {
      const lastmod = (recipe.updated_at || recipe.published_at || new Date().toISOString()).split('T')[0];
      return `  <url>
    <loc>${baseUrl}/resources/blog/${recipe.slug}</loc>
    <lastmod>${lastmod}</lastmod>
    <changefreq>monthly</changefreq>
    <priority>0.7</priority>
  </url>`;
    });

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>${baseUrl}/resources/blog</loc>
    <changefreq>weekly</changefreq>
    <priority>0.8</priority>
  </url>
${urls.join('\n')}
</urlset>`;

    res.set('Content-Type', 'application/xml');
    res.send(xml);
  } catch (error) {
    console.error('[Blog] Error generating sitemap:', error.message);
    res.status(500).json({ success: false, error: 'Failed to generate sitemap' });
  }
});

// ============================================================
// ADMIN ENDPOINTS (require auth + admin)
// ============================================================

/**
 * GET /api/blog/admin/recipes
 * List ALL recipes (drafts + published) for the admin dashboard
 */
router.get('/admin/recipes', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const supabase = getSupabase();
    const { data, error } = await supabase
      .from('blog_recipes')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) throw error;

    res.json({ success: true, recipes: data || [] });
  } catch (error) {
    console.error('[Blog] Error fetching admin recipes:', error.message);
    res.status(500).json({ success: false, error: 'Failed to fetch recipes' });
  }
});

/**
 * POST /api/blog/generate
 * Upload a photo, AI generates a recipe from it
 */
router.post('/generate', authenticateToken, requireAdmin, upload.single('image'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'No image provided' });
    }

    console.log(`[Blog] Generating recipe from photo: ${req.file.originalname} (${req.file.size} bytes)`);

    // Upload image to Supabase Storage
    const imageUrl = await blogRecipeGenerator.uploadImage(req.file.buffer, req.file.mimetype);

    // Convert to base64 for AI analysis
    const base64Image = `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`;

    // Generate recipe from AI
    const recipe = await blogRecipeGenerator.generateRecipe(base64Image);

    // Ensure unique slug
    recipe.slug = await blogRecipeGenerator.ensureUniqueSlug(recipe.slug);

    // Attach the uploaded image URL
    recipe.image_url = imageUrl;

    console.log(`[Blog] Recipe generated: "${recipe.title}" (slug: ${recipe.slug})`);

    res.json({ success: true, recipe });
  } catch (error) {
    console.error('[Blog] Error generating recipe:', error.message);
    res.status(500).json({ success: false, error: error.message || 'Failed to generate recipe' });
  }
});

/**
 * POST /api/blog/recipes
 * Save a new recipe (as draft or published)
 */
router.post('/recipes', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { title, slug, description, image_url, prep_time, cook_time, servings, ingredients, instructions, tags, status } = req.body;

    // Validate required fields
    if (!title || !slug || !description || !image_url || !prep_time || !cook_time || !servings || !ingredients || !instructions) {
      return res.status(400).json({ success: false, error: 'Missing required fields' });
    }

    // Ensure unique slug
    const uniqueSlug = await blogRecipeGenerator.ensureUniqueSlug(slug);

    const recipeData = {
      title,
      slug: uniqueSlug,
      description,
      image_url,
      prep_time,
      cook_time,
      servings: parseInt(servings),
      ingredients: JSON.stringify(ingredients),
      instructions: JSON.stringify(instructions),
      tags: JSON.stringify(tags || []),
      status: status || 'draft',
      published_at: status === 'published' ? new Date().toISOString() : null
    };

    const supabase = getSupabase();
    const { data, error } = await supabase
      .from('blog_recipes')
      .insert(recipeData)
      .select()
      .single();

    if (error) throw error;

    console.log(`[Blog] Recipe saved: "${title}" (status: ${recipeData.status})`);
    res.json({ success: true, recipe: data });
  } catch (error) {
    console.error('[Blog] Error saving recipe:', error.message);
    res.status(500).json({ success: false, error: 'Failed to save recipe' });
  }
});

/**
 * PUT /api/blog/recipes/:id
 * Update an existing recipe
 */
router.put('/recipes/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { title, slug, description, image_url, prep_time, cook_time, servings, ingredients, instructions, tags, status } = req.body;

    const updateData = {
      updated_at: new Date().toISOString()
    };

    // Only update fields that were provided
    if (title !== undefined) updateData.title = title;
    if (slug !== undefined) updateData.slug = slug;
    if (description !== undefined) updateData.description = description;
    if (image_url !== undefined) updateData.image_url = image_url;
    if (prep_time !== undefined) updateData.prep_time = prep_time;
    if (cook_time !== undefined) updateData.cook_time = cook_time;
    if (servings !== undefined) updateData.servings = parseInt(servings);
    if (ingredients !== undefined) updateData.ingredients = JSON.stringify(ingredients);
    if (instructions !== undefined) updateData.instructions = JSON.stringify(instructions);
    if (tags !== undefined) updateData.tags = JSON.stringify(tags);
    if (status !== undefined) {
      updateData.status = status;
      if (status === 'published' && !req.body.published_at) {
        updateData.published_at = new Date().toISOString();
      }
    }

    const supabase = getSupabase();
    const { data, error } = await supabase
      .from('blog_recipes')
      .update(updateData)
      .eq('id', req.params.id)
      .select()
      .single();

    if (error) throw error;

    if (!data) {
      return res.status(404).json({ success: false, error: 'Recipe not found' });
    }

    console.log(`[Blog] Recipe updated: "${data.title}" (id: ${data.id})`);
    res.json({ success: true, recipe: data });
  } catch (error) {
    console.error('[Blog] Error updating recipe:', error.message);
    res.status(500).json({ success: false, error: 'Failed to update recipe' });
  }
});

/**
 * PUT /api/blog/recipes/:id/publish
 * Publish a draft recipe
 */
router.put('/recipes/:id/publish', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const supabase = getSupabase();
    const { data, error } = await supabase
      .from('blog_recipes')
      .update({
        status: 'published',
        published_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      })
      .eq('id', req.params.id)
      .select()
      .single();

    if (error) throw error;

    if (!data) {
      return res.status(404).json({ success: false, error: 'Recipe not found' });
    }

    console.log(`[Blog] Recipe published: "${data.title}"`);
    res.json({ success: true, recipe: data });
  } catch (error) {
    console.error('[Blog] Error publishing recipe:', error.message);
    res.status(500).json({ success: false, error: 'Failed to publish recipe' });
  }
});

/**
 * DELETE /api/blog/recipes/:id
 * Delete a recipe
 */
router.delete('/recipes/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const supabase = getSupabase();

    // Get recipe first to find image URL for cleanup
    const { data: recipe } = await supabase
      .from('blog_recipes')
      .select('id, title, image_url')
      .eq('id', req.params.id)
      .single();

    if (!recipe) {
      return res.status(404).json({ success: false, error: 'Recipe not found' });
    }

    // Delete the recipe
    const { error } = await supabase
      .from('blog_recipes')
      .delete()
      .eq('id', req.params.id);

    if (error) throw error;

    // Try to clean up the image from storage
    if (recipe.image_url && recipe.image_url.includes('blog-recipe-images')) {
      try {
        const fileName = recipe.image_url.split('/blog-recipe-images/')[1];
        if (fileName) {
          await supabase.storage.from('blog-recipe-images').remove([fileName]);
          console.log(`[Blog] Cleaned up image: ${fileName}`);
        }
      } catch (cleanupError) {
        console.warn('[Blog] Image cleanup failed (non-critical):', cleanupError.message);
      }
    }

    console.log(`[Blog] Recipe deleted: "${recipe.title}" (id: ${recipe.id})`);
    res.json({ success: true, message: 'Recipe deleted' });
  } catch (error) {
    console.error('[Blog] Error deleting recipe:', error.message);
    res.status(500).json({ success: false, error: 'Failed to delete recipe' });
  }
});

module.exports = router;
