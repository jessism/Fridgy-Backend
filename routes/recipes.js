const express = require('express');
const multer = require('multer');
const recipeController = require('../controller/recipeController');
const authMiddleware = require('../middleware/auth');
const { checkImportedRecipeLimit, incrementUsageCounter } = require('../middleware/checkLimits');
const recipeService = require('../services/recipeService');
const InstagramExtractor = require('../services/instagramExtractor');
const RecipeAIExtractor = require('../services/recipeAIExtractor');
const ApifyInstagramService = require('../services/apifyInstagramService');
const ProgressiveExtractor = require('../services/progressiveExtractor');
const MultiModalExtractor = require('../services/multiModalExtractor');
const NutritionAnalysisService = require('../services/nutritionAnalysisService');
const NutritionExtractor = require('../services/nutritionExtractor');
const { getServiceClient } = require('../config/supabase');
const { validateShortcutImport, sanitizeRecipeData } = require('../middleware/validation');

const router = express.Router();

// Configure multer for recipe image uploads
const storage = multer.memoryStorage();
const upload = multer({
  storage: storage,
  limits: {
    fileSize: 5 * 1024 * 1024 // 5MB limit for recipe photos
  },
  fileFilter: (req, file, cb) => {
    // Accept only image files
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Only image files are allowed'), false);
    }
  }
});

// Initialize services
const supabase = getServiceClient();
const instagramExtractor = new InstagramExtractor();
const recipeAI = new RecipeAIExtractor();
const apifyService = new ApifyInstagramService();
const multiModalExtractor = new MultiModalExtractor();
const nutritionAnalysis = new NutritionAnalysisService();
const nutritionExtractor = new NutritionExtractor();

/**
 * Recipe Routes
 * All routes require authentication via JWT token
 */

// Health check endpoint (no auth required for monitoring)
router.get('/health', recipeController.healthCheck);

// API Keys health check endpoint (for debugging production issues)
router.get('/health/keys', (req, res) => {
  res.json({
    status: 'ok',
    keys: {
      hasGemini: !!process.env.GOOGLE_GEMINI_API_KEY && process.env.GOOGLE_GEMINI_API_KEY !== 'your_google_gemini_api_key_here',
      hasOpenRouter: !!process.env.OPENROUTER_API_KEY,
      hasApify: !!process.env.APIFY_API_TOKEN,
      hasSpoonacular: !!process.env.SPOONACULAR_API_KEY
    },
    multiModalStatus: {
      geminiConfigured: !!multiModalExtractor.geminiModel,
      openRouterConfigured: !!multiModalExtractor.apiKey
    }
  });
});

// Import recipe from Instagram URL (Web flow for authenticated users)
// POST /api/recipes/import-instagram
router.post('/import-instagram', authMiddleware.authenticateToken, checkImportedRecipeLimit, async (req, res) => {
  try {
    const { url, manualCaption } = req.body;
    const userId = req.user?.userId || req.user?.id;

    console.log('[RecipeImport] Web import request from user:', userId);
    console.log('[RecipeImport] Instagram URL:', url);

    // Validate URL
    if (!url || !url.includes('instagram.com')) {
      return res.status(400).json({
        success: false,
        error: 'Please provide a valid Instagram URL'
      });
    }

    // Check if manual caption was provided
    if (manualCaption) {
      console.log('[RecipeImport] Using manual caption provided by user');
      console.log('[RecipeImport] Manual caption length:', manualCaption.length);

      // Use manual caption instead of API extraction
      var instagramData = {
        success: true,
        caption: manualCaption,
        url: url,
        images: [],
        author: { username: 'unknown' },
        hashtags: []
      };
    } else {
      // Extract Instagram content
      console.log('[RecipeImport] Extracting content from Instagram...');
      var instagramData = await instagramExtractor.extractFromUrl(url);

      // Enhanced debug logging
      console.log('[RecipeImport] Instagram extraction result:', {
        success: instagramData.success,
        hasCaption: !!instagramData.caption,
        captionLength: instagramData.caption?.length || 0,
        captionPreview: instagramData.caption?.substring(0, 200) || 'NO CAPTION',
        imageCount: instagramData.images?.length || 0,
        requiresManualCaption: instagramData.requiresManualCaption,
        error: instagramData.error
      });

      // Check if manual caption is needed
      if (instagramData.requiresManualCaption) {
        console.log('[RecipeImport] Manual caption required');
        return res.json({
          success: false,
          requiresManualCaption: true,
          error: 'Could not fetch Instagram caption automatically. Please provide it manually.',
          message: 'Please paste the recipe caption from Instagram'
        });
      }

      if (!instagramData.success && !instagramData.caption) {
        console.log('[RecipeImport] Instagram extraction failed:', instagramData.error);

        // Still try to process with AI even if Instagram extraction fails
        // AI might be able to work with the URL alone
        console.log('[RecipeImport] Attempting AI extraction with minimal data...');
        instagramData.caption = `Recipe from Instagram URL: ${url}`;
        instagramData.success = true; // Allow AI to try
      }
    }

    console.log('[RecipeImport] Processing with AI...');

    // Extract recipe using AI
    const aiResult = await recipeAI.extractFromInstagramData(instagramData);

    console.log('[RecipeImport] AI extraction result:', {
      success: aiResult.success,
      confidence: aiResult.confidence,
      title: aiResult.recipe?.title
    });

    // Handle low confidence or failed extraction
    // Lowered threshold from 0.5 to 0.3 to accept more partial extractions
    if (!aiResult.success || aiResult.confidence < 0.3) {
      console.log('[RecipeImport] Low confidence extraction, may require manual input');

      // If we have partial data, return it for manual completion
      if (aiResult.recipe && aiResult.recipe.title) {
        return res.json({
          success: false,
          requiresManualInput: true,
          partialRecipe: aiResult.recipe,
          error: 'Recipe extraction needs your help to complete',
          confidence: aiResult.confidence
        });
      }

      return res.status(400).json({
        success: false,
        error: 'Could not extract recipe from this Instagram post. Please try manual entry.',
        requiresManualInput: true
      });
    }

    // Enhanced image selection for standard Instagram import
    const getStandardRecipeImage = () => {
      const imageCandidates = [
        aiResult.recipe.image,                    // AI-suggested image (highest priority)
        instagramData.images?.[0]?.url,           // Primary extracted image
        instagramData.images?.[0],                // Fallback to raw image data
        instagramData.author?.profilePic,         // Author profile pic as last resort
        'https://images.unsplash.com/photo-1546069901-ba9599a7e63c' // Default placeholder
      ];

      for (const candidate of imageCandidates) {
        if (candidate && typeof candidate === 'string' && candidate.startsWith('http')) {
          return candidate;
        }
      }

      return imageCandidates[imageCandidates.length - 1]; // Return placeholder
    };

    const standardSelectedImageUrl = getStandardRecipeImage();

    console.log('[RecipeImport] Image selection debug:', {
      aiRecipeImage: !!aiResult.recipe.image,
      aiRecipeImageValue: aiResult.recipe.image?.substring(0, 100) + '...',
      instagramImageUrl: !!instagramData.images?.[0]?.url,
      instagramImageValue: instagramData.images?.[0]?.url?.substring(0, 100) + '...',
      instagramImageRaw: !!instagramData.images?.[0],
      selectedImage: standardSelectedImageUrl?.substring(0, 100) + '...',
      selectedImageFull: standardSelectedImageUrl,
      isUsingPlaceholder: standardSelectedImageUrl?.includes('images.unsplash.com')
    });

    // Download and store Instagram image in Supabase
    let standardFinalImageUrl = standardSelectedImageUrl;
    let standardDownloadedImageUrl = null;

    if (standardSelectedImageUrl && !standardSelectedImageUrl.includes('images.unsplash.com')) {
      console.log('[RecipeImport] Attempting to download and store Instagram image...');

      // Generate temporary recipe ID for image filename
      const tempRecipeId = `temp-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

      try {
        standardDownloadedImageUrl = await apifyService.downloadInstagramImage(
          standardSelectedImageUrl,
          tempRecipeId,
          userId,
          instagramData // Pass full Instagram response for debugging
        );

        if (standardDownloadedImageUrl) {
          console.log('[RecipeImport] Image successfully downloaded and stored:', standardDownloadedImageUrl);
          standardFinalImageUrl = standardDownloadedImageUrl;
        } else {
          console.log('[RecipeImport] Image download failed, using original Instagram URL');
        }
      } catch (error) {
        console.error('[RecipeImport] Error during image download:', error);
        console.log('[RecipeImport] Falling back to original Instagram URL');
      }
    } else {
      console.log('[RecipeImport] Skipping download for placeholder image');
    }

    // Prepare recipe data for database
    const sanitizedRecipe = sanitizeRecipeData({
      ...aiResult.recipe,
      source_url: url,
      source_author: instagramData.author?.username,
      source_author_image: instagramData.author?.profilePic,
      image: standardFinalImageUrl // Use downloaded image URL or fallback to original
    });

    // Collect all available image URLs for image_urls array
    const standardAllImageUrls = [
      standardSelectedImageUrl,
      aiResult.recipe.image,
      instagramData.images?.[0]?.url,
      instagramData.images?.[0],
      ...((instagramData.images || []).slice(1).map(img => typeof img === 'string' ? img : img?.url).filter(Boolean))
    ].filter((url, index, array) =>
      url &&
      typeof url === 'string' &&
      url.startsWith('http') &&
      array.indexOf(url) === index && // Remove duplicates
      !url.includes('images.unsplash.com') // Remove placeholders from array
    );

    const recipeToSave = {
      user_id: userId,
      source_type: 'instagram',
      source_url: url,
      import_method: 'web',

      // Core recipe data
      title: sanitizedRecipe.title || 'Recipe from Instagram',
      summary: sanitizedRecipe.summary || '',
      image: sanitizedRecipe.image,
      image_urls: standardAllImageUrls.length > 0 ? standardAllImageUrls : null,

      // Match RecipeDetailModal structure
      extendedIngredients: sanitizedRecipe.extendedIngredients || [],
      analyzedInstructions: sanitizedRecipe.analyzedInstructions || [],

      // Time and servings
      readyInMinutes: sanitizedRecipe.readyInMinutes,
      cookingMinutes: sanitizedRecipe.cookingMinutes,
      servings: sanitizedRecipe.servings || 4,

      // Dietary attributes
      vegetarian: sanitizedRecipe.vegetarian || false,
      vegan: sanitizedRecipe.vegan || false,
      glutenFree: sanitizedRecipe.glutenFree || false,
      dairyFree: sanitizedRecipe.dairyFree || false,

      // Additional metadata
      cuisines: sanitizedRecipe.cuisines || [],
      dishTypes: sanitizedRecipe.dishTypes || [],
      diets: sanitizedRecipe.diets || [],

      // AI extraction metadata
      extraction_confidence: aiResult.confidence,
      extraction_notes: aiResult.extractionNotes,
      missing_info: aiResult.missingInfo || [],
      ai_model_used: 'gemini-2.0-flash',

      // Source info
      source_author: sanitizedRecipe.source_author,
      source_author_image: sanitizedRecipe.source_author_image
    };

    // Get nutrition - first try extracting from caption, then fall back to AI estimation
    console.log('[RecipeImport] Getting nutrition for recipe...');
    try {
      let nutritionData = null;

      // STEP 1: Try to extract nutrition from caption (if creator provided it)
      console.log('[RecipeImport] Step 1: Checking caption for nutrition info...');
      const extractedNutrition = await nutritionExtractor.extractFromCaption(instagramData.caption);

      if (extractedNutrition && extractedNutrition.found) {
        console.log('[RecipeImport] ✅ Found nutrition in caption from creator!');
        nutritionData = nutritionExtractor.formatNutritionData(extractedNutrition);
        console.log('[RecipeImport] Extracted nutrition:', {
          calories: nutritionData.perServing?.calories?.amount,
          protein: nutritionData.perServing?.protein?.amount,
          source: 'creator',
          isAIEstimated: false
        });
      } else {
        // STEP 2: Fall back to AI estimation from ingredients
        console.log('[RecipeImport] Step 2: No nutrition in caption, estimating from ingredients...');
        nutritionData = await nutritionAnalysis.analyzeRecipeNutrition(recipeToSave);

        if (nutritionData) {
          console.log('[RecipeImport] ✅ Nutrition estimation successful:', {
            calories: nutritionData.perServing?.calories?.amount,
            confidence: nutritionData.confidence
          });
        } else {
          console.log('[RecipeImport] ⚠️ Nutrition estimation returned no data');
        }
      }

      recipeToSave.nutrition = nutritionData;

    } catch (nutritionError) {
      console.error('[RecipeImport] ❌ Nutrition processing failed:', nutritionError);
      // Don't fail the import if nutrition processing fails
      recipeToSave.nutrition = null;
    }

    // DEBUG: Log exactly what we're trying to save
    console.log('[RecipeImport] DEBUG - About to save to database:', {
      title: recipeToSave.title,
      image: recipeToSave.image,
      imageUrl: recipeToSave.image?.substring(0, 100) + '...',
      isImageNull: recipeToSave.image === null,
      isImageUndefined: recipeToSave.image === undefined,
      image_urls: recipeToSave.image_urls,
      imageUrlsCount: recipeToSave.image_urls?.length,
      standardAllImageUrlsDebug: standardAllImageUrls.map(url => url?.substring(0, 100) + '...'),
      originalInstagramUrl: standardSelectedImageUrl?.substring(0, 100) + '...',
      downloadedImageUrl: standardDownloadedImageUrl?.substring(0, 100) + '...',
      finalImageUrl: standardFinalImageUrl?.substring(0, 100) + '...',
      imageWasDownloaded: !!standardDownloadedImageUrl
    });

    // Save to database
    const { data: savedRecipe, error: saveError } = await supabase
      .from('saved_recipes')
      .insert(recipeToSave)
      .select()
      .single();

    if (saveError) {
      console.error('[RecipeImport] Database save error:', saveError);
      throw saveError;
    }

    console.log('[RecipeImport] Recipe saved successfully:', {
      id: savedRecipe.id,
      title: savedRecipe.title,
      savedImageUrl: savedRecipe.image?.substring(0, 100) + '...',
      savedImageFull: savedRecipe.image,
      hasImageInDb: !!savedRecipe.image,
      savedImageUrls: savedRecipe.image_urls,
      savedImageUrlsCount: savedRecipe.image_urls?.length,
      standardAllImageUrlsDebug: standardAllImageUrls.map(url => url?.substring(0, 100) + '...'),
      imageWasDownloaded: !!standardDownloadedImageUrl,
      originalInstagramUrl: standardSelectedImageUrl?.substring(0, 100) + '...',
      downloadedImageUrl: standardDownloadedImageUrl?.substring(0, 100) + '...'
    });

    // Increment usage counter
    await incrementUsageCounter(userId, 'imported_recipes');
    console.log('[RecipeImport] Usage counter incremented for user:', userId);

    res.json({
      success: true,
      recipe: savedRecipe,
      message: 'Recipe imported successfully from Instagram'
    });

  } catch (error) {
    console.error('[RecipeImport] Import error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to import recipe. Please try again later.'
    });
  }
});

// Import recipe from ANY web URL (non-Instagram)
// ============================================================
// ASYNC RECIPE IMPORT (Background processing + push notification)
// ============================================================

const pushNotificationService = require('../services/pushNotificationService');
const previewJobService = require('../services/previewJobService');
const { parseAIJson } = require('../services/aiJsonParser');

/**
 * POST /api/recipes/import-async
 * Start an async recipe import. Returns immediately with a jobId.
 * Backend processes extraction in the background and sends push notification when done.
 */
router.post('/import-async', authMiddleware.authenticateToken, checkImportedRecipeLimit, async (req, res) => {
  const { url, source_type } = req.body;
  const userId = req.user?.userId || req.user?.id;

  console.log('[AsyncImport] Request from user:', userId);
  console.log('[AsyncImport] URL:', url, 'Source:', source_type);

  if (!url || !source_type) {
    return res.status(400).json({ success: false, error: 'URL and source_type are required' });
  }

  // Generate unique job ID
  const jobId = `import_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

  try {
    // Create job record
    const { error: insertError } = await supabase
      .from('import_jobs')
      .insert({
        id: jobId,
        user_id: userId,
        url,
        source_type,
        status: 'processing',
      });

    if (insertError) {
      console.error('[AsyncImport] Failed to create job:', insertError);
      return res.status(500).json({ success: false, error: 'Failed to start import' });
    }

    // Return immediately — user is free to leave
    res.json({ success: true, jobId, status: 'processing' });

    // Fire-and-forget with a hard deadline: a hang anywhere in the pipeline
    // must surface as a failed job, never a row stuck in 'processing' forever
    runImportWithDeadline(jobId, userId, url, source_type);

  } catch (error) {
    console.error('[AsyncImport] Error:', error);
    res.status(500).json({ success: false, error: 'Failed to start import' });
  }
});

/**
 * GET /api/recipes/import-status/:jobId
 * Poll the status of an async import job.
 */
router.get('/import-status/:jobId', authMiddleware.authenticateToken, async (req, res) => {
  const { jobId } = req.params;
  const userId = req.user?.userId || req.user?.id;

  try {
    const { data, error } = await supabase
      .from('import_jobs')
      .select('id, status, source_type, recipe_id, recipe_name, error')
      .eq('id', jobId)
      .eq('user_id', userId)
      .single();

    if (error || !data) {
      return res.status(404).json({ success: false, error: 'Job not found' });
    }

    // Scan/voice jobs carry the extracted recipe for preview (URL imports
    // save server-side and only need recipeId). Memory is the fast path;
    // result_data (migration 072) survives restarts — selected separately
    // and best-effort so a missing column can't break the shared endpoint.
    let recipe = null;
    if (data.status === 'completed' && ['scan', 'voice', 'meal_scan'].includes(data.source_type)) {
      recipe = previewJobService.getResult(jobId);
      if (!recipe) {
        try {
          const { data: resultRow } = await supabase
            .from('import_jobs')
            .select('result_data')
            .eq('id', jobId)
            .single();
          recipe = resultRow?.result_data || null;
        } catch (resultErr) {
          console.warn(`[AsyncImport] result_data lookup failed for ${jobId}:`, resultErr.message);
        }
      }
    }

    res.json({
      jobId: data.id,
      status: data.status,
      recipeId: data.recipe_id || null,
      recipeName: data.recipe_name || null,
      error: data.error || null,
      ...(recipe ? { recipe } : {}),
    });
  } catch (error) {
    console.error('[AsyncImport] Status check error:', error);
    res.status(500).json({ success: false, error: 'Failed to check status' });
  }
});

/**
 * Background processing function for async recipe imports.
 * Reuses existing extraction pipelines (TikTok, Instagram, YouTube, Facebook).
 */
// Hard ceiling for one import job. The Apify budget is 120s and AI extraction
// adds more; anything past this is a hang (e.g. an AI call that never returns).
const IMPORT_JOB_DEADLINE_MS = 5 * 60 * 1000;

function runImportWithDeadline(jobId, userId, url, sourceType) {
  let deadlineTimer;
  const deadline = new Promise(resolve => {
    deadlineTimer = setTimeout(resolve, IMPORT_JOB_DEADLINE_MS, 'timeout');
  });

  Promise.race([
    processAsyncImport(jobId, userId, url, sourceType).then(() => 'done'),
    deadline,
  ])
    .then(outcome => {
      if (outcome === 'timeout') {
        console.error(`[AsyncImport] Job ${jobId}: deadline exceeded after ${IMPORT_JOB_DEADLINE_MS / 1000}s`);
        return markImportJobFailed(jobId, userId, 'Import timed out. Please try again.');
      }
    })
    .catch(err => {
      console.error(`[AsyncImport] Job ${jobId} unhandled error:`, err);
    })
    .finally(() => clearTimeout(deadlineTimer));
}

/**
 * Mark a job failed and notify the user — but only if it is still 'processing',
 * so a job that already completed (or was already failed by the deadline) is
 * never double-transitioned or double-notified.
 */
async function markImportJobFailed(jobId, userId, errorMessage) {
  const { data, error } = await supabase
    .from('import_jobs')
    .update({
      status: 'failed',
      error: errorMessage || 'Extraction failed',
      completed_at: new Date().toISOString(),
    })
    .eq('id', jobId)
    .eq('status', 'processing')
    .select('id');

  if (error) {
    console.error(`[AsyncImport] Job ${jobId}: failed to mark as failed:`, error);
    return;
  }
  if (!data || data.length === 0) return; // job already left 'processing'

  try {
    await pushNotificationService.sendToUser(userId, {
      title: 'Import failed',
      body: "We couldn't extract a recipe from that video. Try again.",
      tag: 'recipe-import',
      data: {
        screen: '/(tabs)',
        type: 'recipe_import_failed',
        jobId,
      },
      requireInteraction: false,
    });
  } catch (pushErr) {
    console.error(`[AsyncImport] Job ${jobId}: failure notification failed:`, pushErr.message);
  }
}

async function processAsyncImport(jobId, userId, url, sourceType) {
  const NutritionExtractor = require('../services/nutritionExtractor');
  const NutritionAnalysisService = require('../services/nutritionAnalysisService');
  const MultiModalExtractor = require('../services/multiModalExtractor');
  const { sanitizeRecipeData } = require('../middleware/validation');

  const multiModalExtractor = new MultiModalExtractor();
  const nutritionExtractor = new NutritionExtractor();
  const nutritionAnalysis = new NutritionAnalysisService();

  const jobStartedAt = Date.now();
  const elapsed = () => `${((Date.now() - jobStartedAt) / 1000).toFixed(1)}s`;

  try {
    console.log(`[AsyncImport] Job ${jobId}: Starting ${sourceType} extraction for ${url}`);

    let extractedRecipe;

    if (sourceType === 'tiktok') {
      extractedRecipe = await extractTikTokRecipe(url, userId, multiModalExtractor, nutritionExtractor, nutritionAnalysis, sanitizeRecipeData);
    } else if (sourceType === 'instagram') {
      extractedRecipe = await extractInstagramRecipe(url, userId, multiModalExtractor, nutritionExtractor, nutritionAnalysis, sanitizeRecipeData);
    } else if (sourceType === 'youtube') {
      extractedRecipe = await extractYouTubeRecipe(url, userId, multiModalExtractor, nutritionExtractor, nutritionAnalysis, sanitizeRecipeData);
    } else if (sourceType === 'facebook') {
      extractedRecipe = await extractFacebookRecipe(url, userId, multiModalExtractor, nutritionExtractor, nutritionAnalysis, sanitizeRecipeData);
    } else {
      throw new Error(`Unsupported source type: ${sourceType}`);
    }

    if (!extractedRecipe) {
      throw new Error('Extraction returned no recipe');
    }

    console.log(`[AsyncImport] Job ${jobId}: ${sourceType} extraction successful in ${elapsed()} — "${extractedRecipe.title}"`);

    // Save recipe to database
    const recipeToSave = {
      user_id: userId,
      source_type: sourceType,
      source_url: url,
      import_method: 'multi-modal-async',
      title: extractedRecipe.title,
      summary: extractedRecipe.summary || '',
      image: extractedRecipe.image || null,
      image_urls: extractedRecipe.image_urls || null,
      extendedIngredients: extractedRecipe.extendedIngredients || [],
      analyzedInstructions: extractedRecipe.analyzedInstructions || [],
      readyInMinutes: extractedRecipe.readyInMinutes || null,
      cookingMinutes: extractedRecipe.cookingMinutes || null,
      servings: extractedRecipe.servings || 4,
      vegetarian: extractedRecipe.vegetarian || false,
      vegan: extractedRecipe.vegan || false,
      glutenFree: extractedRecipe.glutenFree || false,
      dairyFree: extractedRecipe.dairyFree || false,
      cuisines: extractedRecipe.cuisines || [],
      dishTypes: extractedRecipe.dishTypes || [],
      diets: extractedRecipe.diets || [],
      extraction_confidence: extractedRecipe.extraction_confidence || null,
      extraction_notes: extractedRecipe.extraction_notes || null,
      missing_info: extractedRecipe.missing_info || [],
      source_author: extractedRecipe.source_author || null,
      source_author_image: extractedRecipe.source_author_image || null,
      nutrition: extractedRecipe.nutrition || null,
    };

    const { data: savedRecipe, error: saveError } = await supabase
      .from('saved_recipes')
      .insert(recipeToSave)
      .select()
      .single();

    if (saveError) {
      console.error(`[AsyncImport] Job ${jobId}: Save error:`, saveError);
      throw new Error('Failed to save recipe to database');
    }

    console.log(`[AsyncImport] Job ${jobId}: ${sourceType} import completed in ${elapsed()} — saved as recipe ${savedRecipe.id}`);

    // Increment usage counter
    await incrementUsageCounter(userId, 'imported_recipes');

    // Update job as completed — only if still 'processing'; if the deadline
    // already failed this job, don't resurrect it or send a success push
    const { data: completedRows } = await supabase
      .from('import_jobs')
      .update({
        status: 'completed',
        recipe_id: savedRecipe.id,
        recipe_name: savedRecipe.title,
        completed_at: new Date().toISOString(),
      })
      .eq('id', jobId)
      .eq('status', 'processing')
      .select('id');

    if (!completedRows || completedRows.length === 0) {
      console.warn(`[AsyncImport] Job ${jobId}: finished after being marked failed — recipe ${savedRecipe.id} saved, skipping push`);
      return;
    }

    // Send push notification
    try {
      await pushNotificationService.sendToUser(userId, {
        title: 'Recipe ready!',
        body: `"${savedRecipe.title}" has been saved`,
        tag: 'recipe-import',
        data: {
          screen: `/(tabs)/recipe/${savedRecipe.id}?fromImport=true`,
          type: 'recipe_import_complete',
          jobId,
        },
        requireInteraction: false,
      });
      console.log(`[AsyncImport] Job ${jobId}: Push notification sent`);
    } catch (pushErr) {
      console.error(`[AsyncImport] Job ${jobId}: Push notification failed:`, pushErr.message);
      // Don't throw — recipe was saved successfully
    }

  } catch (error) {
    console.error(`[AsyncImport] Job ${jobId}: ${sourceType} import failed after ${elapsed()}:`, error.message);
    await markImportJobFailed(jobId, userId, error.message);
  }
}

/**
 * Extract recipe from TikTok (reuses existing pipeline)
 */
async function extractTikTokRecipe(url, userId, multiModalExtractor, nutritionExtractor, nutritionAnalysis, sanitizeRecipeData) {
  const tiktokService = require('../services/apifyTikTokService');

  const apifyData = await tiktokService.extractFromUrl(url, userId);
  if (!apifyData.success) {
    throw new Error(apifyData.error || 'Failed to extract TikTok content');
  }

  const result = await multiModalExtractor.extractWithAllModalities(apifyData);
  if (!result.success || !result.recipe) {
    throw new Error(result.error || 'Could not extract recipe from TikTok video');
  }

  // Download and store image permanently
  const tempRecipeId = `tt-temp-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  const primaryImageUrl = result.recipe.image || apifyData.images?.[0]?.url;
  let permanentImageUrl = null;

  if (primaryImageUrl && primaryImageUrl.startsWith('http')) {
    permanentImageUrl = await tiktokService.downloadTikTokImage(primaryImageUrl, tempRecipeId, userId);
  }

  const PLACEHOLDER = 'https://images.unsplash.com/photo-1546069901-ba9599a7e63c?w=400';

  const sanitized = sanitizeRecipeData({
    ...result.recipe,
    source_type: 'tiktok',
    source_url: url,
    source_author: apifyData.author?.username,
    source_author_image: apifyData.author?.profilePic,
    image: permanentImageUrl || PLACEHOLDER,
  });

  // Get nutrition
  try {
    const extractedNutrition = await nutritionExtractor.extractFromCaption(apifyData.caption);
    if (extractedNutrition && extractedNutrition.found) {
      sanitized.nutrition = nutritionExtractor.formatNutritionData(extractedNutrition);
    } else {
      sanitized.nutrition = await nutritionAnalysis.analyzeRecipeNutrition(sanitized);
    }
  } catch (nutritionError) {
    console.error('[AsyncImport] TikTok nutrition failed:', nutritionError.message);
    sanitized.nutrition = null;
  }

  return sanitized;
}

/**
 * Extract recipe from Instagram (reuses existing pipeline)
 */
async function extractInstagramRecipe(url, userId, multiModalExtractor, nutritionExtractor, nutritionAnalysis, sanitizeRecipeData) {
  const ApifyInstagramService = require('../services/apifyInstagramService');
  const apifyService = new ApifyInstagramService();

  const apifyData = await apifyService.extractFromUrl(url, userId);
  if (!apifyData.success) {
    throw new Error(apifyData.error || 'Failed to extract Instagram content');
  }

  const result = await multiModalExtractor.extractWithAllModalities(apifyData);
  if (!result.success || !result.recipe) {
    throw new Error(result.error || 'Could not extract recipe from Instagram post');
  }

  // Download and store image permanently
  const tempRecipeId = `ig-temp-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  const primaryImageUrl = result.recipe.image || apifyData.images?.[0]?.url;
  let permanentImageUrl = null;

  if (primaryImageUrl && primaryImageUrl.startsWith('http')) {
    permanentImageUrl = await apifyService.downloadInstagramImage(primaryImageUrl, tempRecipeId, userId, apifyData);
  }

  const PLACEHOLDER = 'https://images.unsplash.com/photo-1546069901-ba9599a7e63c?w=400';

  const sanitized = sanitizeRecipeData({
    ...result.recipe,
    source_type: 'instagram',
    source_url: url,
    source_author: apifyData.author?.username,
    source_author_image: apifyData.author?.profilePic,
    image: permanentImageUrl || PLACEHOLDER,
  });

  // Get nutrition
  try {
    const extractedNutrition = await nutritionExtractor.extractFromCaption(apifyData.caption);
    if (extractedNutrition && extractedNutrition.found) {
      sanitized.nutrition = nutritionExtractor.formatNutritionData(extractedNutrition);
    } else {
      sanitized.nutrition = await nutritionAnalysis.analyzeRecipeNutrition(sanitized);
    }
  } catch (nutritionError) {
    console.error('[AsyncImport] Instagram nutrition failed:', nutritionError.message);
    sanitized.nutrition = null;
  }

  return sanitized;
}

/**
 * Extract recipe from YouTube (reuses existing pipeline)
 */
async function extractYouTubeRecipe(url, userId, multiModalExtractor, nutritionExtractor, nutritionAnalysis, sanitizeRecipeData) {
  const youtubeService = require('../services/apifyYouTubeService');

  const apifyData = await youtubeService.extractFromUrl(url, userId);
  if (!apifyData.success) {
    throw new Error(apifyData.error || 'Failed to extract YouTube content');
  }

  const result = await multiModalExtractor.extractWithAllModalities(apifyData);
  if (!result.success || !result.recipe) {
    throw new Error(result.error || 'Could not extract recipe from YouTube video');
  }

  const PLACEHOLDER = 'https://images.unsplash.com/photo-1546069901-ba9599a7e63c?w=400';

  const sanitized = sanitizeRecipeData({
    ...result.recipe,
    source_type: 'youtube',
    source_url: url,
    source_author: apifyData.author?.username || apifyData.channelName,
    image: result.recipe.image || apifyData.thumbnail || PLACEHOLDER,
  });

  // Get nutrition
  try {
    sanitized.nutrition = await nutritionAnalysis.analyzeRecipeNutrition(sanitized);
  } catch (nutritionError) {
    console.error('[AsyncImport] YouTube nutrition failed:', nutritionError.message);
    sanitized.nutrition = null;
  }

  return sanitized;
}

/**
 * Extract recipe from Facebook (reuses existing pipeline)
 */
async function extractFacebookRecipe(url, userId, multiModalExtractor, nutritionExtractor, nutritionAnalysis, sanitizeRecipeData) {
  const facebookService = require('../services/apifyFacebookService');

  const apifyData = await facebookService.extractFromUrl(url, userId);
  if (!apifyData.success) {
    throw new Error(apifyData.error || 'Failed to extract Facebook content');
  }

  const result = await multiModalExtractor.extractWithAllModalities(apifyData);
  if (!result.success || !result.recipe) {
    throw new Error(result.error || 'Could not extract recipe from Facebook post');
  }

  // Download and store image permanently
  const tempRecipeId = `fb-temp-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  const primaryImageUrl = result.recipe.image || apifyData.images?.[0]?.url;
  let permanentImageUrl = null;

  if (primaryImageUrl && primaryImageUrl.startsWith('http')) {
    permanentImageUrl = await facebookService.downloadFacebookImage(primaryImageUrl, tempRecipeId, userId);
  }

  const PLACEHOLDER = 'https://images.unsplash.com/photo-1546069901-ba9599a7e63c?w=400';

  const sanitized = sanitizeRecipeData({
    ...result.recipe,
    source_type: 'facebook',
    source_url: url,
    source_author: apifyData.author?.username,
    source_author_image: apifyData.author?.profilePic,
    image: permanentImageUrl || PLACEHOLDER,
  });

  // Get nutrition
  try {
    const extractedNutrition = await nutritionExtractor.extractFromCaption(apifyData.caption);
    if (extractedNutrition && extractedNutrition.found) {
      sanitized.nutrition = nutritionExtractor.formatNutritionData(extractedNutrition);
    } else {
      sanitized.nutrition = await nutritionAnalysis.analyzeRecipeNutrition(sanitized);
    }
  } catch (nutritionError) {
    console.error('[AsyncImport] Facebook nutrition failed:', nutritionError.message);
    sanitized.nutrition = null;
  }

  return sanitized;
}

// ============================================================
// END ASYNC IMPORT
// ============================================================

// POST /api/recipes/import-web
router.post('/import-web', authMiddleware.authenticateToken, checkImportedRecipeLimit, async (req, res) => {
  try {
    const { url } = req.body;
    const userId = req.user?.userId || req.user?.id;

    console.log('[WebImport] Request from user:', userId);
    console.log('[WebImport] URL:', url);

    // Redirect TikTok URLs to TikTok multi-modal pipeline (handles case where mobile app hasn't updated yet)
    if (url && (url.includes('tiktok.com') || url.includes('vm.tiktok.com') || url.includes('vt.tiktok.com'))) {
      console.log('[WebImport] TikTok URL detected, redirecting to TikTok pipeline...');
      const tiktokService = require('../services/apifyTikTokService');
      const MultiModalExtractor = require('../services/multiModalExtractor');
      const NutritionExtractor = require('../services/nutritionExtractor');
      const NutritionAnalysisService = require('../services/nutritionAnalysisService');
      const { sanitizeRecipeData } = require('../middleware/validation');
      const multiModalExtractor = new MultiModalExtractor();
      const nutritionExtractor = new NutritionExtractor();
      const nutritionAnalysis = new NutritionAnalysisService();

      if (!process.env.APIFY_API_TOKEN) {
        return res.status(503).json({ success: false, error: 'TikTok import service not available' });
      }

      const apifyData = await tiktokService.extractFromUrl(url, userId);
      if (!apifyData.success) {
        return res.status(400).json({ success: false, error: apifyData.error || 'Failed to extract TikTok content' });
      }

      const result = await multiModalExtractor.extractWithAllModalities(apifyData);
      if (!result.success || !result.recipe) {
        return res.status(400).json({ success: false, error: result.error || 'Could not extract recipe' });
      }

      // Download image - prefer HTTP URLs, skip Gemini's non-URL image descriptions
      const recipeImage = result.recipe.image;
      const primaryImageUrl = (recipeImage && recipeImage.startsWith('http'))
        ? recipeImage
        : apifyData.images?.[0]?.url;
      console.log('[WebImport] Image URL resolved:', primaryImageUrl?.substring(0, 100) || 'NONE');
      let permanentImageUrl = null;
      if (primaryImageUrl && primaryImageUrl.startsWith('http')) {
        const tempId = `tt-temp-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
        permanentImageUrl = await tiktokService.downloadTikTokImage(primaryImageUrl, tempId, userId);
      }
      const PLACEHOLDER = 'https://images.unsplash.com/photo-1546069901-ba9599a7e63c?w=400';

      const sanitized = sanitizeRecipeData({
        ...result.recipe,
        source_type: 'tiktok',
        source_url: url,
        source_author: apifyData.author?.username,
        image: permanentImageUrl || PLACEHOLDER
      });

      // Nutrition
      try {
        const extracted = await nutritionExtractor.extractFromCaption(apifyData.caption);
        sanitized.nutrition = (extracted?.found) ? nutritionExtractor.formatNutritionData(extracted) : await nutritionAnalysis.analyzeRecipeNutrition(sanitized);
      } catch (e) { sanitized.nutrition = null; }

      // Save to database (production app routes here via import-web, expects saved recipe with DB id)
      console.log('[WebImport] Saving TikTok recipe to database...');
      const recipeToSave = {
        user_id: userId,
        ...sanitized,
      };
      const { data: savedRecipe, error: saveError } = await supabase
        .from('saved_recipes')
        .insert(recipeToSave)
        .select()
        .single();

      if (saveError) {
        console.error('[WebImport] TikTok recipe save error:', saveError);
        throw saveError;
      }

      await incrementUsageCounter(userId, 'imported_recipes');
      console.log('[WebImport] TikTok recipe saved successfully:', savedRecipe.id, savedRecipe.title);

      return res.json({
        success: true,
        recipe: savedRecipe,
        confidence: result.confidence,
        extractionMethod: 'multi-modal',
        platform: 'tiktok'
      });
    }

    // Validate URL
    if (!url) {
      return res.status(400).json({
        success: false,
        error: 'Please provide a URL'
      });
    }

    // Basic URL validation
    let parsedUrl;
    try {
      parsedUrl = new URL(url);
    } catch {
      return res.status(400).json({
        success: false,
        error: 'Please provide a valid URL'
      });
    }

    // Redirect Instagram URLs to dedicated endpoint
    if (url.includes('instagram.com')) {
      return res.status(400).json({
        success: false,
        error: 'For Instagram recipes, please use the Instagram import option',
        useInstagramImport: true
      });
    }

    // Extract recipe using Gemini AI with Wayback fallback
    console.log('[WebImport] Extracting recipe with Gemini AI...');
    let extractedRecipe;
    try {
      const RecipeAIExtractor = require('../services/recipeAIExtractor');
      const recipeAI = new RecipeAIExtractor();
      extractedRecipe = await recipeAI.extractFromWebUrl(url);

      // Log if recipe came from archive
      if (extractedRecipe._fromWaybackMachine) {
        console.log('[WebImport] ✅ Recipe extracted from Wayback Machine archive:', extractedRecipe._archiveDate);
      }
    } catch (extractError) {
      // Enhanced error logging with categorization
      console.error('[WebImport] AI extraction failed:', {
        url,
        code: extractError.code,
        message: extractError.message,
        userMessage: extractError.userMessage,
        httpStatus: extractError.httpStatus
      });

      // Determine appropriate HTTP status code based on error type
      let httpStatus = 400;
      if (extractError.code === 'HTTP_403' || extractError.code === 'BOT_DETECTED') {
        httpStatus = 403; // Forbidden - bot protection
      } else if (extractError.code === 'HTTP_404') {
        httpStatus = 404; // Not found
      } else if (extractError.code === 'HTTP_429') {
        httpStatus = 429; // Rate limit
      } else if (extractError.code === 'FETCH_TIMEOUT') {
        httpStatus = 504; // Gateway timeout
      } else if (extractError.httpStatus >= 500) {
        httpStatus = 502; // Bad gateway - upstream server error
      }

      return res.status(httpStatus).json({
        success: false,
        error: extractError.userMessage || 'Could not extract recipe from this URL. The page may not contain a recognizable recipe.',
        errorCode: extractError.code || 'EXTRACTION_FAILED',
        requiresManualInput: true
      });
    }

    // Prepare recipe for database (Spoonacular format matches our schema)
    const recipeToSave = {
      user_id: userId,
      source_type: 'web',
      source_url: url,
      import_method: 'ai-web-extract',

      // Core recipe data
      title: extractedRecipe.title || 'Recipe from Web',
      summary: extractedRecipe.summary || '',
      image: extractedRecipe.image || null,

      // Recipe details (Spoonacular format matches exactly)
      extendedIngredients: extractedRecipe.extendedIngredients || [],
      analyzedInstructions: extractedRecipe.analyzedInstructions || [],

      // Time and servings
      readyInMinutes: extractedRecipe.readyInMinutes || null,
      cookingMinutes: extractedRecipe.cookingMinutes || null,
      servings: extractedRecipe.servings || 4,

      // Dietary attributes
      vegetarian: extractedRecipe.vegetarian || false,
      vegan: extractedRecipe.vegan || false,
      glutenFree: extractedRecipe.glutenFree || false,
      dairyFree: extractedRecipe.dairyFree || false,

      // Additional metadata
      cuisines: extractedRecipe.cuisines || [],
      dishTypes: extractedRecipe.dishTypes || [],
      diets: extractedRecipe.diets || [],

      // Extraction metadata
      extraction_confidence: 0.85, // AI extraction is reliable
      extraction_notes: 'Extracted via Gemini AI web extraction',
      ai_model_used: 'google/gemini-2.5-flash-lite',

      // Source info
      source_author: extractedRecipe.sourceName || extractedRecipe.creditsText || null
    };

    // Get nutrition estimation
    console.log('[WebImport] Analyzing nutrition...');
    try {
      const nutritionData = await nutritionAnalysis.analyzeRecipeNutrition(recipeToSave);
      if (nutritionData) {
        console.log('[WebImport] ✅ Nutrition analysis successful');
        recipeToSave.nutrition = nutritionData;
      }
    } catch (nutritionError) {
      console.error('[WebImport] Nutrition analysis failed:', nutritionError.message);
      recipeToSave.nutrition = null;
    }

    // Save to database
    console.log('[WebImport] Saving to database...');
    const { data: savedRecipe, error: saveError } = await supabase
      .from('saved_recipes')
      .insert(recipeToSave)
      .select()
      .single();

    if (saveError) {
      console.error('[WebImport] Database save error:', saveError);
      throw saveError;
    }

    // Increment usage counter
    await incrementUsageCounter(userId, 'imported_recipes');
    console.log('[WebImport] Recipe saved successfully:', savedRecipe.id, savedRecipe.title);

    res.json({
      success: true,
      recipe: savedRecipe,
      message: 'Recipe imported successfully from web',
      extractionMeta: {
        method: 'spoonacular',
        confidence: 0.95,
        sourceType: 'web'
      }
    });

  } catch (error) {
    console.error('[WebImport] Error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to import recipe. Please try again.'
    });
  }
});

// NEW: Multi-modal extraction endpoint (unified caption + video + audio analysis)
// POST /api/recipes/multi-modal-extract
router.post('/multi-modal-extract', authMiddleware.authenticateToken, checkImportedRecipeLimit, async (req, res) => {
  try {
    const { url } = req.body;
    const userId = req.user?.userId || req.user?.id;

    console.log('[MultiModal] Starting multi-modal extraction for user:', userId);
    console.log('[MultiModal] Instagram URL:', url);

    // Validate URL
    if (!url || !url.includes('instagram.com')) {
      return res.status(400).json({
        success: false,
        error: 'Please provide a valid Instagram URL'
      });
    }

    // Extract with Apify for video content
    console.log('[MultiModal] Fetching Instagram data with Apify...');
    const apifyData = await apifyService.extractFromUrl(url, userId);

    console.log('[MultiModal] Author from Apify:', apifyData.author?.username || 'NO USERNAME');

    if (!apifyData.success) {
      console.log('[MultiModal] Apify extraction failed:', apifyData.error);
      return res.status(400).json({
        success: false,
        error: apifyData.error || 'Failed to extract Instagram content',
        limitExceeded: apifyData.limitExceeded,
        isTimeout: apifyData.isTimeout || false,
        technicalError: apifyData.technicalError
      });
    }

    console.log('[MultiModal] Apify extraction successful:', {
      hasCaption: !!apifyData.caption,
      hasVideo: !!apifyData.videoUrl,
      videoDuration: apifyData.videoDuration,
      imageCount: apifyData.images?.length || 0
    });

    // Use multi-modal extractor for unified analysis
    console.log('[MultiModal] Starting unified multi-modal analysis...');
    const result = await multiModalExtractor.extractWithAllModalities(apifyData);

    if (!result.success || !result.recipe) {
      console.log('[MultiModal] Extraction failed or incomplete:', {
        errorMessage: result.error,
        errorDetails: result.errorDetails
      });
      return res.status(400).json({
        success: false,
        error: result.error || 'Could not extract recipe with multi-modal analysis',
        errorDetails: result.errorDetails,
        partialRecipe: result.recipe,
        confidence: result.confidence
      });
    }

    console.log('[MultiModal] Extraction successful:', {
      confidence: result.confidence,
      sourcesUsed: result.sourcesUsed,
      processingTime: result.processingTime
    });

    // Download and store images permanently before returning
    console.log('[MultiModal] Downloading and storing images permanently...');

    // Generate a unique recipe ID for this import (will be used for filenames)
    const tempRecipeId = `temp-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

    // Download the main image
    let permanentImageUrl = null;
    const primaryImageUrl = result.recipe.image || apifyData.images?.[0]?.url;

    if (primaryImageUrl && primaryImageUrl.startsWith('http')) {
      console.log('[MultiModal] Downloading primary image:', primaryImageUrl.substring(0, 100) + '...');
      permanentImageUrl = await apifyService.downloadInstagramImage(
        primaryImageUrl,
        tempRecipeId,
        userId,
        apifyData
      );

      if (permanentImageUrl) {
        console.log('[MultiModal] ✅ Primary image saved to Supabase:', permanentImageUrl);
      } else {
        console.log('[MultiModal] ⚠️ Failed to download primary image - will use placeholder');
        console.log('[MultiModal] Original URL was:', primaryImageUrl?.substring(0, 100) + '...');
        // DO NOT save expiring Instagram URLs - use null to trigger placeholder
        permanentImageUrl = null;
      }
    }

    // Download additional images if available
    const permanentImageUrls = [];
    if (apifyData.images && apifyData.images.length > 0) {
      console.log(`[MultiModal] Processing ${apifyData.images.length} additional images...`);

      for (let i = 0; i < Math.min(apifyData.images.length, 5); i++) { // Limit to 5 images
        const imgUrl = apifyData.images[i]?.url || apifyData.images[i];
        if (imgUrl && imgUrl.startsWith('http') && imgUrl !== primaryImageUrl) {
          const savedUrl = await apifyService.downloadInstagramImage(
            imgUrl,
            `${tempRecipeId}-${i}`,
            userId,
            apifyData
          );

          if (savedUrl) {
            permanentImageUrls.push(savedUrl);
            console.log(`[MultiModal] ✅ Additional image ${i + 1} saved`);
          } else {
            console.log(`[MultiModal] ⚠️ Failed to save additional image ${i + 1}`);
          }
        }
      }
    }

    // Use placeholder image if permanent download failed
    const PLACEHOLDER_IMAGE = 'https://images.unsplash.com/photo-1546069901-ba9599a7e63c?w=400';
    const finalImageUrl = permanentImageUrl || PLACEHOLDER_IMAGE;

    if (!permanentImageUrl) {
      console.log('[MultiModal] ⚠️ Using placeholder image - original download failed');
    }

    // Prepare recipe data with permanent image URLs only
    const sanitizedRecipe = sanitizeRecipeData({
      ...result.recipe,
      source_type: 'instagram',
      source_url: url,
      source_author: apifyData.author?.username,
      source_author_image: apifyData.author?.profilePic,
      image: finalImageUrl,
      image_urls: permanentImageUrls.length > 0 ? permanentImageUrls : undefined
    });

    // Get nutrition - first try extracting from caption, then fall back to AI estimation
    console.log('[MultiModal] Getting nutrition for extracted recipe...');
    console.log('[MultiModal] Recipe has ingredients:', {
      count: sanitizedRecipe.extendedIngredients?.length || 0,
      sample: sanitizedRecipe.extendedIngredients?.[0]
    });

    try {
      let nutritionData = null;

      // STEP 1: Try to extract nutrition from caption (if creator provided it)
      console.log('[MultiModal] Step 1: Checking caption for nutrition info...');
      const extractedNutrition = await nutritionExtractor.extractFromCaption(apifyData.caption);

      if (extractedNutrition && extractedNutrition.found) {
        console.log('[MultiModal] ✅ Found nutrition in caption from creator!');
        nutritionData = nutritionExtractor.formatNutritionData(extractedNutrition);
        console.log('[MultiModal] Extracted nutrition:', {
          calories: nutritionData.perServing?.calories?.amount,
          protein: nutritionData.perServing?.protein?.amount,
          carbs: nutritionData.perServing?.carbohydrates?.amount,
          fat: nutritionData.perServing?.fat?.amount,
          source: 'creator',
          isAIEstimated: false
        });
      } else {
        // STEP 2: Fall back to AI estimation from ingredients
        console.log('[MultiModal] Step 2: No nutrition in caption, estimating from ingredients...');
        nutritionData = await nutritionAnalysis.analyzeRecipeNutrition(sanitizedRecipe);

        if (nutritionData) {
          console.log('[MultiModal] ✅ Nutrition estimation successful:', {
            calories: nutritionData.perServing?.calories?.amount,
            protein: nutritionData.perServing?.protein?.amount,
            carbs: nutritionData.perServing?.carbohydrates?.amount,
            fat: nutritionData.perServing?.fat?.amount,
            confidence: nutritionData.confidence,
            isAIEstimated: nutritionData.isAIEstimated
          });
        } else {
          console.log('[MultiModal] ⚠️ Nutrition estimation returned no data');
        }
      }

      sanitizedRecipe.nutrition = nutritionData;

    } catch (nutritionError) {
      console.error('[MultiModal] ❌ Nutrition processing failed:', nutritionError.message);
      console.error('[MultiModal] Full error:', nutritionError);
      // Don't fail the extraction if nutrition processing fails
      sanitizedRecipe.nutrition = null;
    }

    // Return the extracted recipe without saving
    res.json({
      success: true,
      recipe: sanitizedRecipe,
      confidence: result.confidence,
      sourcesUsed: result.sourcesUsed,
      processingTime: result.processingTime,
      extractionMethod: 'multi-modal',
      sourceAttribution: result.sourceAttribution || null
    });

  } catch (error) {
    console.error('[MultiModal] Error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Multi-modal extraction failed'
    });
  }
});

// Import recipe from Instagram URL using Apify (Premium flow with video analysis)
// POST /api/recipes/import-instagram-apify
router.post('/import-instagram-apify', authMiddleware.authenticateToken, checkImportedRecipeLimit, async (req, res) => {
  try {
    const { url } = req.body;
    const userId = req.user?.userId || req.user?.id;

    console.log('[ApifyImport] Premium import request from user:', userId);
    console.log('[ApifyImport] Instagram URL:', url);

    // Validate URL
    if (!url || !url.includes('instagram.com')) {
      return res.status(400).json({
        success: false,
        error: 'Please provide a valid Instagram URL'
      });
    }

    // Check if Apify is configured
    if (!process.env.APIFY_API_TOKEN) {
      console.log('[ApifyImport] Apify not configured, falling back to standard import');
      return res.status(503).json({
        success: false,
        error: 'Premium import service not available',
        fallbackAvailable: true
      });
    }

    // Get usage stats first
    const usageStats = await apifyService.getUsageStats(userId);
    console.log('[ApifyImport] Current usage:', usageStats);

    // Extract Instagram content using Apify
    console.log('[ApifyImport] Starting Apify extraction...');
    const apifyData = await apifyService.extractFromUrl(url, userId);

    // Check if limit exceeded
    if (apifyData.limitExceeded) {
      console.log('[ApifyImport] Usage limit exceeded');
      return res.status(429).json({
        success: false,
        error: 'Monthly limit reached for premium imports',
        limitExceeded: true,
        usage: apifyData.usage,
        fallbackAvailable: true
      });
    }

    if (!apifyData.success) {
      console.log('[ApifyImport] Apify extraction failed:', apifyData.error);
      return res.status(400).json({
        success: false,
        error: apifyData.error || 'Failed to extract content from Instagram',
        fallbackAvailable: true
      });
    }

    console.log('[ApifyImport] Apify extraction successful:', {
      hasVideo: !!apifyData.videoUrl,
      videoDuration: apifyData.videoDuration,
      hasCaption: !!apifyData.caption,
      imageCount: apifyData.images?.length || 0
    });

    // TIER 1: Caption-Based Processing (Fast & Cheap)
    console.log('[ApifyImport] Starting TIER 1: Caption-based extraction...');

    const tier1Result = await recipeAI.extractFromApifyData(apifyData);
    let tier2Result = null; // Initialize for scope

    console.log('[ApifyImport] TIER 1 result:', {
      success: tier1Result.success,
      confidence: tier1Result.confidence,
      tier: tier1Result.tier,
      title: tier1Result.recipe?.title
    });

    // TIER 1 DECISION: Check if confidence > 0.7
    if (tier1Result.success && tier1Result.confidence >= 0.7) {
      console.log('[ApifyImport] ✅ TIER 1 SUCCESS - Using caption-based extraction');
      var finalResult = tier1Result;
    } else {
      console.log('[ApifyImport] ⚠️ TIER 1 INSUFFICIENT - Proceeding to TIER 2...');

      // TIER 2: Multi-Modal Video Analysis (Comprehensive & Expensive)
      if (apifyData.videoUrl) {
        console.log('[ApifyImport] Starting TIER 2: Video analysis...');

        tier2Result = await recipeAI.extractFromVideoData(apifyData);

        console.log('[ApifyImport] TIER 2 result:', {
          success: tier2Result.success,
          confidence: tier2Result.confidence,
          tier: tier2Result.tier,
          title: tier2Result.recipe?.title,
          videoAnalyzed: tier2Result.videoAnalyzed,
          videoExpired: tier2Result.videoExpired
        });

        // Handle video URL expiration - fall back to Tier 1
        if (tier2Result.videoExpired) {
          console.log('[ApifyImport] ⚠️ Video URL expired - using TIER 1 result as fallback');
          var finalResult = tier1Result;
        }
        // TIER 2 DECISION: Check if confidence > 0.5
        else if (tier2Result.success && tier2Result.confidence >= 0.5) {
          console.log('[ApifyImport] ✅ TIER 2 SUCCESS - Using video-enhanced extraction');
          var finalResult = tier2Result;
        } else {
          console.log('[ApifyImport] ❌ TIER 2 FAILED - Both tiers insufficient, requiring manual input');

          // Use best result for partial extraction
          const bestResult = tier2Result.confidence >= tier1Result.confidence ? tier2Result : tier1Result;

          if (bestResult.recipe && bestResult.recipe.title) {
            return res.json({
              success: false,
              requiresManualInput: true,
              partialRecipe: bestResult.recipe,
              error: 'Recipe extraction needs your help to complete',
              confidence: bestResult.confidence,
              tier1Confidence: tier1Result.confidence,
              tier2Confidence: tier2Result.confidence,
              videoUrl: apifyData.videoUrl,
              extractionNotes: `Tier 1: ${tier1Result.confidence.toFixed(2)}, Tier 2: ${tier2Result.confidence.toFixed(2)} - both below thresholds`
            });
          }

          return res.status(400).json({
            success: false,
            error: 'Could not extract recipe with either caption or video analysis. Please try manual entry.',
            requiresManualInput: true,
            tier1Confidence: tier1Result.confidence,
            tier2Confidence: tier2Result.confidence
          });
        }
      } else {
        console.log('[ApifyImport] ❌ No video available for TIER 2 - Tier 1 failed and no fallback possible');

        // No video available for Tier 2, check if Tier 1 has any usable data
        if (tier1Result.recipe && tier1Result.recipe.title && tier1Result.confidence >= 0.3) {
          return res.json({
            success: false,
            requiresManualInput: true,
            partialRecipe: tier1Result.recipe,
            error: 'Recipe extraction needs your help to complete',
            confidence: tier1Result.confidence,
            tier1Confidence: tier1Result.confidence,
            extractionNotes: `Tier 1 only: ${tier1Result.confidence.toFixed(2)} - below 0.7 threshold, no video for Tier 2`
          });
        }

        return res.status(400).json({
          success: false,
          error: 'Could not extract recipe from caption and no video available for enhanced analysis. Please try manual entry.',
          requiresManualInput: true,
          tier1Confidence: tier1Result.confidence
        });
      }
    }

    var aiResult = finalResult; // For compatibility with existing code below

    // Enhanced image selection with smart URL strategy for different sources
    const getRecipeImage = () => {
      console.log('[ApifyImport] === IMAGE SELECTION STRATEGY ===');

      // Step 1: Look for Apify proxied URLs first (highest priority)
      const responseString = JSON.stringify(apifyData);
      if (responseString.includes('apifyusercontent.com')) {
        const apifyMatch = responseString.match(/https:\/\/images\.apifyusercontent\.com\/[^"]+/);
        if (apifyMatch) {
          console.log('[ApifyImport] ✅ Found Apify proxied URL - using directly:', apifyMatch[0].substring(0, 100) + '...');
          return apifyMatch[0];
        }
      }

      // Step 2: Test if Instagram scontent URLs work directly (skip download)
      const scontent = apifyData.displayUrl;
      if (scontent && scontent.includes('scontent') && scontent.includes('cdninstagram.com')) {
        console.log('[ApifyImport] 🧪 Using Instagram scontent URL directly (will test without download):', scontent.substring(0, 100) + '...');
        return scontent; // We'll try this URL directly without downloading
      }

      // Step 3: Fallback to other candidates
      const imageCandidates = [
        aiResult.recipe.image,                    // AI-suggested image
        apifyData.images?.[0]?.url,               // Primary Apify extracted image
        apifyData.images?.[0],                    // Fallback to raw image data
        apifyData.author?.profilePic,             // Author profile pic
        // Food-themed fallback images for different recipe types
        getFoodPlaceholderImage(aiResult.recipe),
        'https://images.unsplash.com/photo-1546069901-ba9599a7e63c' // Default placeholder
      ];

      let selectedImage = null;
      for (const candidate of imageCandidates) {
        if (candidate && typeof candidate === 'string' && candidate.startsWith('http')) {
          console.log(`[ApifyImport] Fallback candidate: ${apifyService.identifyImageUrlType(candidate)} - ${candidate.substring(0, 100)}...`);
          selectedImage = candidate;
          break;
        }
      }

      if (!selectedImage) {
        console.log('[ApifyImport] ❌ No valid image found, using default placeholder');
        selectedImage = imageCandidates[imageCandidates.length - 1];
      }

      console.log('[ApifyImport] Final selected URL type:', apifyService.identifyImageUrlType(selectedImage));
      return selectedImage;
    };

    // Helper to get food-themed placeholder based on recipe content
    const getFoodPlaceholderImage = (recipe) => {
      if (!recipe?.title && !recipe?.cuisines?.length && !recipe?.dishTypes?.length) {
        return null;
      }

      const title = (recipe.title || '').toLowerCase();
      const cuisines = (recipe.cuisines || []).join(' ').toLowerCase();
      const dishTypes = (recipe.dishTypes || []).join(' ').toLowerCase();
      const content = `${title} ${cuisines} ${dishTypes}`;

      // Food-specific placeholders
      if (content.includes('pasta') || content.includes('spaghetti') || content.includes('italian')) {
        return 'https://images.unsplash.com/photo-1551892374-ecf8be341df9'; // Pasta
      }
      if (content.includes('pizza')) {
        return 'https://images.unsplash.com/photo-1513104890138-7c749659a591'; // Pizza
      }
      if (content.includes('salad')) {
        return 'https://images.unsplash.com/photo-1512621776951-a57141f2eefd'; // Salad
      }
      if (content.includes('salmon') || content.includes('fish')) {
        return 'https://images.unsplash.com/photo-1519708227418-c8fd9a32b7a2'; // Salmon
      }
      if (content.includes('chicken')) {
        return 'https://images.unsplash.com/photo-1598103442097-8b74394b95c6'; // Chicken
      }
      if (content.includes('asian') || content.includes('chinese') || content.includes('japanese')) {
        return 'https://images.unsplash.com/photo-1559847844-d651ce8ce84e'; // Asian food
      }

      return null; // No specific match
    };

    const selectedImageUrl = getRecipeImage();

    console.log('[ApifyImport] Image selection debug:', {
      aiRecipeImage: !!aiResult.recipe.image,
      aiRecipeImageValue: aiResult.recipe.image?.substring(0, 100) + '...',
      apifyImageUrl: !!apifyData.images?.[0]?.url,
      apifyImageValue: apifyData.images?.[0]?.url?.substring(0, 100) + '...',
      apifyImageRaw: !!apifyData.images?.[0],
      hasVideo: !!apifyData.videoUrl,
      selectedImage: selectedImageUrl?.substring(0, 100) + '...',
      selectedImageFull: selectedImageUrl,
      isUsingPlaceholder: selectedImageUrl?.includes('images.unsplash.com')
    });

    // Smart image handling strategy
    let finalImageUrl = selectedImageUrl;
    let downloadedImageUrl = null;
    const urlType = apifyService.identifyImageUrlType(selectedImageUrl);

    console.log('[ApifyImport] === IMAGE HANDLING STRATEGY ===');
    console.log('[ApifyImport] Selected URL type:', urlType);
    console.log('[ApifyImport] Selected URL:', selectedImageUrl?.substring(0, 150) + '...');

    if (selectedImageUrl && !selectedImageUrl.includes('images.unsplash.com')) {
      if (urlType === 'APIFY_PROXIED') {
        console.log('[ApifyImport] ✅ Using Apify proxied URL directly - no download needed');
        finalImageUrl = selectedImageUrl;
      } else if (urlType === 'INSTAGRAM_SCONTENT') {
        console.log('[ApifyImport] 🧪 Testing Instagram scontent URL directly first...');
        // Try using the Instagram scontent URL directly
        finalImageUrl = selectedImageUrl;

        // Optional: Test if it actually works by making a HEAD request
        try {
          const testResponse = await fetch(selectedImageUrl, { method: 'HEAD', timeout: 5000 });
          if (testResponse.ok) {
            console.log('[ApifyImport] ✅ Instagram scontent URL works directly - using without download');
          } else {
            console.log('[ApifyImport] ❌ Instagram scontent URL failed test, will try download...');
            throw new Error('HEAD request failed');
          }
        } catch (error) {
          console.log('[ApifyImport] Instagram scontent test failed, attempting download...');

          // Generate temporary recipe ID for image filename
          const tempRecipeId = `temp-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

          try {
            downloadedImageUrl = await apifyService.downloadInstagramImage(
              selectedImageUrl,
              tempRecipeId,
              userId,
              apifyData // Pass full Apify response for debugging
            );

            if (downloadedImageUrl) {
              console.log('[ApifyImport] ✅ Image successfully downloaded and stored:', downloadedImageUrl);
              finalImageUrl = downloadedImageUrl;
            } else {
              console.log('[ApifyImport] ❌ Image download failed, using original Instagram URL anyway');
            }
          } catch (downloadError) {
            console.error('[ApifyImport] Error during image download:', downloadError);
            console.log('[ApifyImport] Falling back to original Instagram URL');
          }
        }
      } else {
        console.log('[ApifyImport] Unknown URL type, attempting download...');

        // Generate temporary recipe ID for image filename
        const tempRecipeId = `temp-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

        try {
          downloadedImageUrl = await apifyService.downloadInstagramImage(
            selectedImageUrl,
            tempRecipeId,
            userId,
            apifyData // Pass full Apify response for debugging
          );

          if (downloadedImageUrl) {
            console.log('[ApifyImport] Image successfully downloaded and stored:', downloadedImageUrl);
            finalImageUrl = downloadedImageUrl;
          } else {
            console.log('[ApifyImport] Image download failed, using original URL');
          }
        } catch (error) {
          console.error('[ApifyImport] Error during image download:', error);
          console.log('[ApifyImport] Falling back to original URL');
        }
      }
    } else {
      console.log('[ApifyImport] Skipping download for placeholder image');
    }

    // Prepare recipe data with video metadata
    const sanitizedRecipe = sanitizeRecipeData({
      ...aiResult.recipe,
      source_url: url,
      source_author: apifyData.author?.username,
      source_author_image: apifyData.author?.profilePic,
      image: finalImageUrl // Use downloaded image URL or fallback to original
    });

    // Collect all available image URLs for image_urls array
    const allImageUrls = [
      selectedImageUrl,
      aiResult.recipe.image,
      apifyData.images?.[0]?.url,
      ...((apifyData.images || []).slice(1).map(img => img?.url).filter(Boolean))
    ].filter((url, index, array) =>
      url &&
      url.startsWith('http') &&
      array.indexOf(url) === index && // Remove duplicates
      !url.includes('images.unsplash.com') // Remove placeholders from array
    );

    const recipeToSave = {
      user_id: userId,
      source_type: 'instagram',
      source_url: url,
      import_method: 'apify',

      // Core recipe data
      title: sanitizedRecipe.title || 'Recipe from Instagram',
      summary: sanitizedRecipe.summary || '',
      image: sanitizedRecipe.image,
      image_urls: allImageUrls.length > 0 ? allImageUrls : null,

      // Video metadata (new fields)
      video_url: apifyData.videoUrl,
      video_duration: apifyData.videoDuration ? Math.round(apifyData.videoDuration) : null,
      extracted_with_apify: true,
      video_analysis_confidence: aiResult.videoConfidence || aiResult.confidence,
      video_view_count: apifyData.viewCount,

      // Match RecipeDetailModal structure
      extendedIngredients: sanitizedRecipe.extendedIngredients || [],
      analyzedInstructions: sanitizedRecipe.analyzedInstructions || [],

      // Time and servings
      readyInMinutes: sanitizedRecipe.readyInMinutes,
      cookingMinutes: sanitizedRecipe.cookingMinutes,
      servings: sanitizedRecipe.servings || 4,

      // Dietary attributes
      vegetarian: sanitizedRecipe.vegetarian || false,
      vegan: sanitizedRecipe.vegan || false,
      glutenFree: sanitizedRecipe.glutenFree || false,
      dairyFree: sanitizedRecipe.dairyFree || false,

      // Additional metadata
      cuisines: sanitizedRecipe.cuisines || [],
      dishTypes: sanitizedRecipe.dishTypes || [],
      diets: sanitizedRecipe.diets || [],

      // AI extraction metadata (using existing schema columns only)
      extraction_confidence: aiResult.confidence,
      extraction_notes: aiResult.extractionNotes || `Tier ${aiResult.tier} ${aiResult.extractionMethod || 'caption-based'} extraction${tier1Result ? ` (T1: ${tier1Result.confidence.toFixed(2)})` : ''}${tier2Result ? ` (T2: ${tier2Result.confidence.toFixed(2)})` : ''}${aiResult.videoAnalyzed ? ' with video analysis' : ''}`,
      missing_info: aiResult.missingInfo || [],
      ai_model_used: aiResult.tier === 2 ? 'gemini-flash-1.5-8b-tier2' : 'gemini-flash-1.5-8b-tier1',

      // Source info
      source_author: apifyData.author?.username,
      source_author_image: apifyData.author?.profilePic
    };

    // DEBUG: Log exactly what we're trying to save
    console.log('[ApifyImport] DEBUG - About to save to database:', {
      title: recipeToSave.title,
      image: recipeToSave.image,
      imageUrl: recipeToSave.image?.substring(0, 100) + '...',
      isImageNull: recipeToSave.image === null,
      isImageUndefined: recipeToSave.image === undefined,
      image_urls: recipeToSave.image_urls,
      imageUrlsCount: recipeToSave.image_urls?.length,
      allImageUrlsDebug: allImageUrls.map(url => url?.substring(0, 100) + '...'),
      originalInstagramUrl: selectedImageUrl?.substring(0, 100) + '...',
      downloadedImageUrl: downloadedImageUrl?.substring(0, 100) + '...',
      finalImageUrl: finalImageUrl?.substring(0, 100) + '...',
      imageWasDownloaded: !!downloadedImageUrl,
      video_duration: recipeToSave.video_duration,
      video_duration_type: typeof recipeToSave.video_duration,
      raw_videoDuration: apifyData.videoDuration,
      raw_videoDuration_type: typeof apifyData.videoDuration,
      video_analysis_confidence: recipeToSave.video_analysis_confidence,
      video_view_count: recipeToSave.video_view_count
    });

    // Get nutrition - first try extracting from caption, then fall back to AI estimation
    console.log('[ApifyImport] Getting nutrition for recipe...');
    try {
      let nutritionData = null;

      // STEP 1: Try to extract nutrition from caption (if creator provided it)
      console.log('[ApifyImport] Step 1: Checking caption for nutrition info...');
      const extractedNutrition = await nutritionExtractor.extractFromCaption(apifyData.caption);

      if (extractedNutrition && extractedNutrition.found) {
        console.log('[ApifyImport] ✅ Found nutrition in caption from creator!');
        nutritionData = nutritionExtractor.formatNutritionData(extractedNutrition);
        console.log('[ApifyImport] Extracted nutrition:', {
          calories: nutritionData.perServing?.calories?.amount,
          protein: nutritionData.perServing?.protein?.amount,
          source: 'creator',
          isAIEstimated: false
        });
      } else {
        // STEP 2: Fall back to AI estimation from ingredients
        console.log('[ApifyImport] Step 2: No nutrition in caption, estimating from ingredients...');
        nutritionData = await nutritionAnalysis.analyzeRecipeNutrition(recipeToSave);

        if (nutritionData) {
          console.log('[ApifyImport] ✅ Nutrition estimation successful:', {
            calories: nutritionData.perServing?.calories?.amount,
            confidence: nutritionData.confidence
          });
        } else {
          console.log('[ApifyImport] ⚠️ Nutrition estimation returned no data');
        }
      }

      recipeToSave.nutrition = nutritionData;

    } catch (nutritionError) {
      console.error('[ApifyImport] ❌ Nutrition processing failed:', nutritionError);
      // Don't fail the import if nutrition processing fails
      recipeToSave.nutrition = null;
    }

    // Save to database
    const { data: savedRecipe, error: saveError } = await supabase
      .from('saved_recipes')
      .insert(recipeToSave)
      .select()
      .single();

    if (saveError) {
      console.error('[ApifyImport] Database save error:', saveError);
      throw saveError;
    }

    // Get updated usage stats
    const updatedUsage = await apifyService.getUsageStats(userId);

    console.log('[ApifyImport] Recipe saved successfully:', {
      id: savedRecipe.id,
      title: savedRecipe.title,
      savedImageUrl: savedRecipe.image?.substring(0, 100) + '...',
      savedImageFull: savedRecipe.image,
      hasImageInDb: !!savedRecipe.image,
      savedImageUrls: savedRecipe.image_urls,
      savedImageUrlsCount: savedRecipe.image_urls?.length,
      imageWasDownloaded: !!downloadedImageUrl,
      originalInstagramUrl: selectedImageUrl?.substring(0, 100) + '...',
      downloadedImageUrl: downloadedImageUrl?.substring(0, 100) + '...',
      tier: aiResult.tier,
      confidence: aiResult.confidence,
      method: aiResult.extractionMethod
    });

    // Increment usage counter
    await incrementUsageCounter(userId, 'imported_recipes');
    console.log('[ApifyImport] Usage counter incremented for user:', userId);

    res.json({
      success: true,
      recipe: savedRecipe,
      message: `Recipe imported successfully using ${aiResult.extractionMethod} (Tier ${aiResult.tier})`,
      usage: updatedUsage,
      extractionMeta: {
        tier: aiResult.tier,
        method: aiResult.extractionMethod,
        confidence: aiResult.confidence,
        videoAnalyzed: aiResult.videoAnalyzed || false,
        tier1Confidence: tier1Result ? tier1Result.confidence : null,
        tier2Confidence: tier2Result ? tier2Result.confidence : null,
        notes: `Tier ${aiResult.tier} ${aiResult.extractionMethod || 'caption-based'} extraction`
      }
    });

  } catch (error) {
    console.error('[ApifyImport] Import error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to import recipe. Please try the standard import.',
      fallbackAvailable: true
    });
  }
});

// Get Apify usage stats for current user
// GET /api/recipes/apify-usage
router.get('/apify-usage', authMiddleware.authenticateToken, async (req, res) => {
  try {
    const userId = req.user?.userId || req.user?.id;
    const usage = await apifyService.getUsageStats(userId);

    res.json({
      success: true,
      usage: usage
    });
  } catch (error) {
    console.error('[ApifyUsage] Error getting usage stats:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get usage statistics'
    });
  }
});

// Get recipe suggestions based on user's inventory
// GET /api/recipes/suggestions (supports both GET and POST for demo inventory)
router.get('/suggestions', authMiddleware.authenticateToken, recipeController.getSuggestions);
router.post('/suggestions', authMiddleware.authenticateToken, recipeController.getSuggestions);

// Get curated/popular recipes
// GET /api/recipes/curated
router.get('/curated', async (req, res) => {
  try {
    console.log('[Curated] Fetching curated recipes');

    const { data: recipes, error } = await supabase
      .from('saved_recipes')
      .select('*')
      .eq('visibility', 'curated')
      .order('created_at', { ascending: false });

    if (error) {
      console.error('[Curated] Database error:', error);
      throw error;
    }

    console.log(`[Curated] Found ${recipes?.length || 0} curated recipes`);

    res.json({
      success: true,
      recipes: recipes || []
    });
  } catch (error) {
    console.error('[Curated] Error fetching curated recipes:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to fetch curated recipes'
    });
  }
});

// Save extracted recipe (from multi-modal or other extraction methods)
// POST /api/recipes/save
router.post('/save', authMiddleware.authenticateToken, async (req, res) => {
  try {
    const { recipe, source_url, import_method, confidence } = req.body;
    const userId = req.user?.userId || req.user?.id;

    console.log('[RecipeSave] Saving extracted recipe for user:', userId);
    console.log('[RecipeSave] Recipe title:', recipe?.title);
    console.log('[RecipeSave] Import method:', import_method);
    console.log('[RecipeSave] Source author:', recipe?.source_author || 'NOT PROVIDED');
    console.log('[RecipeSave] Recipe image URL:', recipe?.image || 'NO IMAGE PROVIDED');

    // Validate recipe data
    if (!recipe || !recipe.title) {
      return res.status(400).json({
        success: false,
        error: 'Invalid recipe data - missing title'
      });
    }

    // Prepare recipe for database with case-sensitive column names
    const recipeToSave = {
      user_id: userId,
      source_type: recipe.source_type || (source_url?.includes('instagram') ? 'instagram' : source_url?.includes('facebook.com') || source_url?.includes('fb.watch') ? 'facebook' : 'web'),
      source_url: source_url || null,
      import_method: import_method || 'manual',
      // extraction_method column doesn't exist - removed

      // Core recipe data
      title: recipe.title,
      summary: recipe.summary || '',
      image: recipe.image || null,
      image_urls: recipe.image_urls || null,

      // Recipe details - Supabase client handles case-sensitivity
      extendedIngredients: recipe.extendedIngredients || [],
      analyzedInstructions: recipe.analyzedInstructions || [],

      // Time and servings
      readyInMinutes: recipe.readyInMinutes || null,
      cookingMinutes: recipe.cookingMinutes || null,
      servings: recipe.servings || 4,

      // Dietary attributes
      vegetarian: recipe.vegetarian || false,
      vegan: recipe.vegan || false,
      glutenFree: recipe.glutenFree || false,
      dairyFree: recipe.dairyFree || false,

      // Additional metadata
      cuisines: recipe.cuisines || [],
      dishTypes: recipe.dishTypes || [],
      diets: recipe.diets || [],

      // Extraction metadata
      extraction_confidence: confidence || null,
      extraction_notes: recipe.extraction_notes || null,
      missing_info: recipe.missing_info || [],

      // Source info
      source_author: recipe.source_author || null,
      source_author_image: recipe.source_author_image || null
      // source_attribution column doesn't exist - removed
    };

    console.log('[RecipeSave] Saving to database...');

    // Check if nutrition already exists or needs analysis
    if (recipe.nutrition) {
      console.log('[RecipeSave] Recipe already has nutrition data:', {
        hasNutrition: true,
        isAIEstimated: recipe.nutrition.isAIEstimated,
        calories: recipe.nutrition.perServing?.calories?.amount,
        source: import_method
      });
      recipeToSave.nutrition = recipe.nutrition;
    } else {
      // Analyze nutrition for the recipe using the original recipe object
      console.log('[RecipeSave] Recipe missing nutrition data, analyzing...', {
        source: import_method,
        sourceType: source_url?.includes('instagram') ? 'instagram' : 'web',
        ingredientCount: recipe.extendedIngredients?.length || 0
      });

      try {
        const nutritionData = await nutritionAnalysis.analyzeRecipeNutrition(recipe);
        if (nutritionData) {
          console.log('[RecipeSave] ✅ Nutrition analysis successful:', {
            calories: nutritionData.perServing?.calories?.amount,
            protein: nutritionData.perServing?.protein?.amount,
            carbs: nutritionData.perServing?.carbohydrates?.amount,
            fat: nutritionData.perServing?.fat?.amount,
            confidence: nutritionData.confidence,
            isAIEstimated: nutritionData.isAIEstimated
          });
          recipeToSave.nutrition = nutritionData;
        } else {
          console.log('[RecipeSave] ⚠️ Nutrition analysis returned no data');
          recipeToSave.nutrition = null;
        }
      } catch (nutritionError) {
        console.error('[RecipeSave] ❌ Nutrition analysis failed:', nutritionError.message);
        // Don't fail the import if nutrition analysis fails
        recipeToSave.nutrition = null;
      }
    }

    // Save to database
    const { data: savedRecipe, error: saveError } = await supabase
      .from('saved_recipes')
      .insert(recipeToSave)
      .select()
      .single();

    if (saveError) {
      console.error('[RecipeSave] Database save error:', saveError);
      return res.status(500).json({
        success: false,
        error: 'Failed to save recipe to database'
      });
    }

    console.log('[RecipeSave] Recipe saved successfully:', savedRecipe.id);
    console.log('[RecipeSave] Saved recipe image URL:', savedRecipe.image || 'NO IMAGE IN SAVED RECIPE');

    // Increment usage counter
    await incrementUsageCounter(userId, 'imported_recipes');
    console.log('[RecipeSave] Usage counter incremented for user:', userId);

    res.json({
      success: true,
      recipe: savedRecipe,
      message: 'Recipe saved successfully'
    });

  } catch (error) {
    console.error('[RecipeSave] Error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to save recipe'
    });
  }
});

// Upload recipe image
// POST /api/recipes/upload-image
router.post('/upload-image', authMiddleware.authenticateToken, upload.single('image'), async (req, res) => {
  try {
    const userId = req.user?.userId || req.user?.id;

    if (!req.file) {
      return res.status(400).json({
        success: false,
        error: 'No image file provided'
      });
    }

    console.log('[Recipe Image Upload] Starting upload for user:', userId);
    console.log('[Recipe Image Upload] File size:', req.file.size, 'bytes');
    console.log('[Recipe Image Upload] File type:', req.file.mimetype);

    // Check if bucket exists and is public
    console.log('[Recipe Image Upload] Checking bucket configuration...');

    // Create filename with timestamp for uniqueness
    const timestamp = Date.now();
    const randomId = Math.random().toString(36).substring(7);
    const fileName = `${userId}/manual/${timestamp}_${randomId}.jpg`;

    console.log('[Recipe Image Upload] Uploading to user-recipe-photos bucket:', fileName);

    // Upload to Supabase Storage - user-recipe-photos bucket
    const { data: uploadData, error: uploadError } = await supabase.storage
      .from('user-recipe-photos')
      .upload(fileName, req.file.buffer, {
        contentType: req.file.mimetype || 'image/jpeg',
        upsert: false
      });

    if (uploadError) {
      console.error('[Recipe Image Upload] Storage upload error:', uploadError);

      // If bucket doesn't exist, try to create it
      if (uploadError.message && uploadError.message.includes('not found')) {
        console.log('[Recipe Image Upload] Bucket not found, creating user-recipe-photos bucket...');

        // Note: Bucket creation requires admin permissions
        // This should be done via Supabase dashboard or migration
        return res.status(500).json({
          success: false,
          error: 'Storage bucket not configured. Please contact support.',
          details: 'user-recipe-photos bucket needs to be created'
        });
      }

      return res.status(500).json({
        success: false,
        error: 'Failed to upload image to storage',
        details: uploadError.message
      });
    }

    // Get public URL for the uploaded image
    const { data: urlData } = supabase.storage
      .from('user-recipe-photos')
      .getPublicUrl(fileName);

    const imageUrl = urlData.publicUrl;

    console.log('[Recipe Image Upload] Upload successful');
    console.log('[Recipe Image Upload] Public URL:', imageUrl);

    // Verify the URL format
    if (!imageUrl || imageUrl === 'null' || imageUrl === 'undefined') {
      console.error('[Recipe Image Upload] WARNING: Invalid public URL generated');
      console.error('[Recipe Image Upload] URL Data:', urlData);
    } else if (!imageUrl.startsWith('http')) {
      console.error('[Recipe Image Upload] WARNING: URL does not start with http:', imageUrl);
    }

    res.json({
      success: true,
      imageUrl: imageUrl,
      fileName: fileName
    });

  } catch (error) {
    console.error('[Recipe Image Upload] Error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to upload image',
      details: error.message
    });
  }
});

/**
 * Transform AI nutrition response (nutrients array) into the mobile app's perServing format.
 * Keeps unit info in the amount fields for display.
 */
function transformNutrition(nutrition) {
  if (!nutrition) return null;

  // If already in perServing format, return as-is
  if (nutrition.perServing) return nutrition;

  // Transform from nutrients array to perServing object
  const nutrients = nutrition.nutrients || [];
  const findNutrient = (name) => {
    const n = nutrients.find(x => x.name.toLowerCase() === name.toLowerCase());
    return n ? { amount: n.amount } : undefined;
  };

  return {
    perServing: {
      calories: findNutrient('Calories'),
      protein: findNutrient('Protein'),
      carbohydrates: findNutrient('Carbohydrates'),
      fat: findNutrient('Fat'),
      fiber: findNutrient('Fiber'),
      sugar: findNutrient('Sugar'),
      sodium: findNutrient('Sodium'),
    },
    caloricBreakdown: nutrition.caloricBreakdown || null,
    isAIEstimated: true,
  };
}

/**
 * Create recipe from voice recording
 * POST /api/recipes/create-from-voice
 *
 * Accepts multipart/form-data with an audio file.
 * Backend transcribes via Whisper, then structures into a recipe via Gemini.
 * Returns structured Recipe JSON with estimated nutrition.
 */
const voiceUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 30 * 1024 * 1024 }, // 30MB for long recordings
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('audio/') || file.mimetype === 'application/octet-stream') {
      cb(null, true);
    } else {
      cb(new Error('Only audio files are allowed'), false);
    }
  }
});

/**
 * Transcribe + structure a voice recording into a recipe via Gemini.
 * Shared by the sync route (old app bundles) and the async route.
 * Throws an Error with code 'NO_RECIPE' when no recipe is found in the audio.
 */
async function voiceAudioToRecipe(file, requestId) {
    // Use Google Gemini to transcribe audio + structure recipe in one call
    const { GoogleGenerativeAI } = require('@google/generative-ai');
    const geminiKey = process.env.GOOGLE_GEMINI_API_KEY;
    if (!geminiKey) {
      throw new Error('Google Gemini API key not configured');
    }

    const genAI = new GoogleGenerativeAI(geminiKey);
    const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

    // Convert audio buffer to base64 for inline data
    const audioBase64 = file.buffer.toString('base64');
    const mimeType = file.mimetype || 'audio/mp4';

    console.log(`[VoiceRecipe:${requestId}] Sending audio to Gemini for transcription + recipe structuring...`);

    const recipePrompt = `You are a recipe extraction AI. Listen to this audio recording where a user describes a recipe by speaking aloud.
The speech may be conversational, include filler words, um's, corrections, or tangents.
Your job is to transcribe what they said and extract a clean, structured recipe from it.

Return ONLY valid JSON (no markdown, no explanation) in this exact format:
{
  "title": "Recipe name",
  "summary": "Brief 1-2 sentence description of the dish",
  "extendedIngredients": [
    {"id": 1, "amount": 2, "unit": "cups", "name": "flour", "original": "2 cups flour"}
  ],
  "analyzedInstructions": [
    {"name": "", "steps": [{"number": 1, "step": "First step description"}]}
  ],
  "readyInMinutes": 30,
  "servings": 4,
  "vegetarian": false,
  "vegan": false,
  "glutenFree": false,
  "dairyFree": false,
  "cuisines": [],
  "dishTypes": [],
  "nutrition": {
    "nutrients": [
      {"name": "Calories", "amount": 350, "unit": "kcal"},
      {"name": "Protein", "amount": 15, "unit": "g"},
      {"name": "Carbohydrates", "amount": 45, "unit": "g"},
      {"name": "Fat", "amount": 12, "unit": "g"},
      {"name": "Fiber", "amount": 3, "unit": "g"},
      {"name": "Sugar", "amount": 8, "unit": "g"},
      {"name": "Sodium", "amount": 400, "unit": "mg"}
    ],
    "caloricBreakdown": {
      "percentProtein": 17,
      "percentFat": 31,
      "percentCarbs": 52
    },
    "isEstimated": true
  }
}

RULES:

INGREDIENTS — STAY FAITHFUL TO THE USER'S WORDS:
- Extract ONLY what the user actually said. Do NOT invent amounts, quantities, or measurements they didn't mention.
- If the user says "chicken thighs" without a quantity, set amount to 0 and unit to "" — just the name "chicken thighs". Do NOT guess "4" or "500g".
- If the user gives a measurement (e.g., "2 cups of rice"), use exactly that amount and unit.
- The "original" field should reflect what the user actually said as closely as possible.

INSTRUCTIONS — STAY FAITHFUL TO THE USER'S WORDS:
- Extract ALL cooking steps in order — honor the exact number of steps the user describes. Do NOT split one step into multiple or add extra steps.
- Use the user's own words and phrasing. Clean up filler words (um, uh, like) but keep the actual content faithful.
- Only elaborate steps if the user is extremely vague or gives no clear step breakdown.

OTHER RULES:
- Convert fractions to decimals (1/2 → 0.5, 1 1/2 → 1.5)
- Ignore filler words, pauses, tangents — but preserve the recipe content exactly
- If the user corrects themselves ("no wait, 2 cups not 3"), use the correction
- Estimate nutrition per serving based on the ingredients (nutrition estimation is OK to be AI-generated)
- Set dietary flags (vegetarian, vegan, etc.) based on ingredients
- If no recipe can be found in the audio, return {"error": "No recipe found in audio"}
- Return ONLY the JSON object, no other text. Output STRICT JSON: no comments (// or /* */), no trailing commas`;

    const result = await model.generateContent([
      {
        inlineData: {
          mimeType: mimeType,
          data: audioBase64,
        }
      },
      recipePrompt,
    ]);

    const aiContent = result.response?.text();

    if (!aiContent) {
      throw new Error('No response from Gemini');
    }

    console.log(`[VoiceRecipe:${requestId}] Gemini response (${aiContent.length} chars)`);


    // Parse JSON from AI response (handle markdown code blocks)
    let recipe;
    try {
      recipe = parseAIJson(aiContent);
    } catch (parseError) {
      console.error(`[VoiceRecipe:${requestId}] JSON parse error:`, parseError.message);
      console.error(`[VoiceRecipe:${requestId}] Raw AI content:`, aiContent.substring(0, 500));
      throw new Error('Failed to parse recipe from AI response');
    }

    // Check if AI couldn't find a recipe
    if (recipe.error) {
      const noRecipeErr = new Error(recipe.error);
      noRecipeErr.code = 'NO_RECIPE';
      throw noRecipeErr;
    }

    // Normalize the recipe structure
    const structuredRecipe = {
      title: recipe.title || 'Untitled Recipe',
      summary: recipe.summary || '',
      image: null,
      extendedIngredients: (recipe.extendedIngredients || []).map((ing, index) => ({
        id: ing.id || index + 1,
        amount: ing.amount || 0,
        unit: ing.unit || '',
        name: ing.name || '',
        original: ing.original || `${ing.amount || ''} ${ing.unit || ''} ${ing.name || ''}`.trim()
      })),
      analyzedInstructions: recipe.analyzedInstructions || [{ name: '', steps: [] }],
      readyInMinutes: recipe.readyInMinutes || null,
      servings: recipe.servings || 4,
      vegetarian: recipe.vegetarian || false,
      vegan: recipe.vegan || false,
      glutenFree: recipe.glutenFree || false,
      dairyFree: recipe.dairyFree || false,
      cuisines: recipe.cuisines || [],
      dishTypes: recipe.dishTypes || [],
      nutrition: transformNutrition(recipe.nutrition),
      source_type: 'voice',
    };

    console.log(`[VoiceRecipe:${requestId}] ✅ Recipe structured: "${structuredRecipe.title}" with ${structuredRecipe.extendedIngredients.length} ingredients, ${structuredRecipe.analyzedInstructions[0]?.steps?.length || 0} steps`);

    return structuredRecipe;
}

router.post('/create-from-voice', authMiddleware.authenticateToken, checkImportedRecipeLimit, voiceUpload.single('audio'), async (req, res) => {
  const requestId = Math.random().toString(36).substring(7);
  const userId = req.user?.userId || req.user?.id;

  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'Audio file is required' });
    }

    console.log(`[VoiceRecipe:${requestId}] User: ${userId}, Audio size: ${req.file.size} bytes, Type: ${req.file.mimetype}`);

    const structuredRecipe = await voiceAudioToRecipe(req.file, requestId);

    // Increment usage counter
    await incrementUsageCounter(userId, 'imported_recipes');

    res.json({
      success: true,
      recipe: structuredRecipe,
    });

  } catch (error) {
    console.error(`[VoiceRecipe:${requestId}] Error:`, error);

    if (error.code === 'NO_RECIPE') {
      return res.status(400).json({
        success: false,
        error: error.message
      });
    }

    if (error.name === 'AbortError') {
      return res.status(504).json({
        success: false,
        error: 'Recipe processing timed out. Please try a shorter recording.'
      });
    }

    res.status(500).json({
      success: false,
      error: 'Failed to create recipe from voice. Please try again.',
      details: error.message,
    });
  }
});

/**
 * POST /api/recipes/create-from-voice-async
 * Same payload as /create-from-voice, but returns a jobId immediately and
 * processes in the background — avoids Railway's ~30s request timeout on
 * long recordings. Poll via GET /api/recipes/import-status/:jobId; the
 * completed job carries the extracted recipe for preview.
 */
router.post('/create-from-voice-async', authMiddleware.authenticateToken, checkImportedRecipeLimit, voiceUpload.single('audio'), async (req, res) => {
  const userId = req.user?.userId || req.user?.id;

  if (!req.file) {
    return res.status(400).json({ success: false, error: 'Audio file is required' });
  }

  try {
    const jobId = await previewJobService.createPreviewJob(userId, 'voice');

    console.log(`[VoiceJob] Job ${jobId}: user ${userId}, audio ${req.file.size} bytes (${req.file.mimetype})`);

    // Return immediately — the phone polls for the result
    res.json({ success: true, jobId, status: 'processing' });

    processVoiceJob(jobId, userId, req.file).catch(err => {
      console.error(`[VoiceJob] Job ${jobId} unhandled error:`, err);
    });
  } catch (error) {
    console.error('[VoiceJob] Failed to start:', error);
    res.status(500).json({ success: false, error: 'Failed to start voice recipe' });
  }
});

/**
 * Background processor for voice recipe jobs.
 */
async function processVoiceJob(jobId, userId, file) {
  try {
    const structuredRecipe = await voiceAudioToRecipe(file, jobId);

    await incrementUsageCounter(userId, 'imported_recipes');

    console.log(`[VoiceJob] Job ${jobId}: completed — "${structuredRecipe.title}"`);
    await previewJobService.completePreviewJob(jobId, userId, structuredRecipe, 'voice');
  } catch (error) {
    console.error(`[VoiceJob] Job ${jobId}: failed:`, error.message);
    const message = error.code === 'NO_RECIPE'
      ? error.message
      : 'Failed to create recipe from voice. Please try again.';
    await previewJobService.failPreviewJob(jobId, userId, message, 'voice');
  }
}

// Get detailed recipe information
// GET /api/recipes/:id
// NOTE: This generic route must come AFTER all specific routes
router.get('/:id', authMiddleware.authenticateToken, recipeController.getRecipeDetails);

// Mark ingredients as used when cooking a recipe
// POST /api/recipes/:id/cook
router.post('/:id/cook', authMiddleware.authenticateToken, recipeController.markRecipeCooked);

module.exports = router;