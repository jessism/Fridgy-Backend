const express = require('express');
const recipeController = require('../controller/recipeController');
const authMiddleware = require('../middleware/auth');
const edamamService = require('../services/edamamService');
const recipeService = require('../services/recipeService');
const InstagramExtractor = require('../services/instagramExtractor');
const RecipeAIExtractor = require('../services/recipeAIExtractor');
const ApifyInstagramService = require('../services/apifyInstagramService');
const ProgressiveExtractor = require('../services/progressiveExtractor');
const MultiModalExtractor = require('../services/multiModalExtractor');
const NutritionAnalysisService = require('../services/nutritionAnalysisService');
const { getServiceClient } = require('../config/supabase');
const { validateShortcutImport, sanitizeRecipeData } = require('../middleware/validation');

const router = express.Router();

// Initialize services
const supabase = getServiceClient();
const instagramExtractor = new InstagramExtractor();
const recipeAI = new RecipeAIExtractor();
const apifyService = new ApifyInstagramService();
const multiModalExtractor = new MultiModalExtractor();
const nutritionAnalysis = new NutritionAnalysisService();

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
      hasSpoonacular: !!process.env.SPOONACULAR_API_KEY,
      hasEdamam: !!process.env.EDAMAM_APP_ID && !!process.env.EDAMAM_APP_KEY
    },
    multiModalStatus: {
      geminiConfigured: !!multiModalExtractor.geminiModel,
      openRouterConfigured: !!multiModalExtractor.apiKey
    }
  });
});

// Import recipe from Instagram URL (Web flow for authenticated users)
// POST /api/recipes/import-instagram
router.post('/import-instagram', authMiddleware.authenticateToken, async (req, res) => {
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

    // Analyze nutrition for the recipe
    console.log('[RecipeImport] Analyzing nutrition for recipe...');
    try {
      const nutritionData = await nutritionAnalysis.analyzeRecipeNutrition(recipeToSave);
      if (nutritionData) {
        console.log('[RecipeImport] Nutrition analysis successful:', {
          calories: nutritionData.perServing?.calories?.amount,
          confidence: nutritionData.confidence
        });
        recipeToSave.nutrition = nutritionData;
      } else {
        console.log('[RecipeImport] Nutrition analysis returned no data');
        recipeToSave.nutrition = null;
      }
    } catch (nutritionError) {
      console.error('[RecipeImport] Nutrition analysis failed:', nutritionError);
      // Don't fail the import if nutrition analysis fails
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

// NEW: Multi-modal extraction endpoint (unified caption + video + audio analysis)
// POST /api/recipes/multi-modal-extract
router.post('/multi-modal-extract', authMiddleware.authenticateToken, async (req, res) => {
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

    if (!apifyData.success) {
      console.log('[MultiModal] Apify extraction failed:', apifyData.error);
      return res.status(400).json({
        success: false,
        error: apifyData.error || 'Failed to extract Instagram content',
        limitExceeded: apifyData.limitExceeded
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
      console.log('[MultiModal] Extraction failed or incomplete');
      return res.status(400).json({
        success: false,
        error: 'Could not extract recipe with multi-modal analysis',
        partialRecipe: result.recipe,
        confidence: result.confidence
      });
    }

    console.log('[MultiModal] Extraction successful:', {
      confidence: result.confidence,
      sourcesUsed: result.sourcesUsed,
      processingTime: result.processingTime
    });

    // Prepare recipe data (but don't save yet - let frontend confirm)
    const sanitizedRecipe = sanitizeRecipeData({
      ...result.recipe,
      source_url: url,
      source_author: apifyData.author?.username,
      image: result.recipe.image || apifyData.images?.[0]?.url
    });

    // Analyze nutrition for the recipe
    console.log('[MultiModal] Analyzing nutrition for extracted recipe...');
    try {
      const nutritionData = await nutritionAnalysis.analyzeRecipeNutrition(sanitizedRecipe);
      if (nutritionData) {
        console.log('[MultiModal] Nutrition analysis successful:', {
          calories: nutritionData.perServing?.calories?.amount,
          confidence: nutritionData.confidence
        });
        sanitizedRecipe.nutrition = nutritionData;
      } else {
        console.log('[MultiModal] Nutrition analysis returned no data');
        sanitizedRecipe.nutrition = null;
      }
    } catch (nutritionError) {
      console.error('[MultiModal] Nutrition analysis failed:', nutritionError);
      // Don't fail the extraction if nutrition analysis fails
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
router.post('/import-instagram-apify', authMiddleware.authenticateToken, async (req, res) => {
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

    // Analyze nutrition for the recipe
    console.log('[ApifyImport] Analyzing nutrition for recipe...');
    try {
      const nutritionData = await nutritionAnalysis.analyzeRecipeNutrition(recipeToSave);
      if (nutritionData) {
        console.log('[ApifyImport] Nutrition analysis successful:', {
          calories: nutritionData.perServing?.calories?.amount,
          confidence: nutritionData.confidence
        });
        recipeToSave.nutrition = nutritionData;
      } else {
        console.log('[ApifyImport] Nutrition analysis returned no data');
        recipeToSave.nutrition = null;
      }
    } catch (nutritionError) {
      console.error('[ApifyImport] Nutrition analysis failed:', nutritionError);
      // Don't fail the import if nutrition analysis fails
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
// GET /api/recipes/suggestions
router.get('/suggestions', authMiddleware.authenticateToken, recipeController.getSuggestions);

// Simple Edamam connection test
// GET /api/recipes/edamam-test/check
router.get('/edamam-test/check', async (req, res) => {
  console.log('\n🔬 Testing Edamam connection...');
  
  try {
    // Test with a simple query
    const testRecipes = await edamamService.searchRecipesByIngredients(
      ['chicken', 'rice'],
      { number: 2 }
    );
    
    res.json({
      success: true,
      message: 'Edamam API connection successful',
      recipesFound: testRecipes.length,
      credentials: {
        appIdSet: !!process.env.EDAMAM_APP_ID,
        appKeySet: !!process.env.EDAMAM_APP_KEY
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
      credentials: {
        appIdSet: !!process.env.EDAMAM_APP_ID,
        appKeySet: !!process.env.EDAMAM_APP_KEY,
        appIdValue: process.env.EDAMAM_APP_ID
      }
    });
  }
});

// Edamam test route for side-by-side comparison
// GET /api/recipes/edamam-test/suggestions
// IMPORTANT: This must come BEFORE the /:id route to avoid being caught by the ID parameter
router.get('/edamam-test/suggestions', authMiddleware.authenticateToken, async (req, res) => {
  const requestId = Math.random().toString(36).substring(7);
  
  try {
    console.log(`\n🧪 Edamam test request: ${requestId}`);
    
    // Get user ID from JWT token
    const userId = req.user?.userId || req.user?.id;
    console.log(`🧪 User ID: ${userId}`);
    
    // Check if Edamam is configured
    if (!process.env.EDAMAM_APP_ID || !process.env.EDAMAM_APP_KEY) {
      throw new Error('Edamam API credentials not configured');
    }
    
    // Get user's inventory
    const inventory = await recipeService.getUserInventory(userId);
    
    if (inventory.length === 0) {
      console.log(`⚠️ No inventory items found for user`);
      return res.json({
        success: true,
        suggestions: [],
        source: 'edamam',
        message: 'No inventory items to search with'
      });
    }
    
    // Prioritize ingredients
    const prioritizedIngredients = recipeService.prioritizeIngredients(inventory);
    const ingredientNames = prioritizedIngredients.map(item => item.item_name);
    
    console.log(`🧪 Searching Edamam with: ${ingredientNames.join(', ')}`);
    
    // Get recipes from Edamam
    const edamamRecipes = await edamamService.searchRecipesByIngredients(
      ingredientNames,
      { number: parseInt(req.query.limit) || 8 }
    );
    
    console.log(`🧪 Found ${edamamRecipes.length} Edamam recipes`);
    
    res.json({
      success: true,
      suggestions: edamamRecipes,
      source: 'edamam',
      count: edamamRecipes.length
    });
    
  } catch (error) {
    console.error(`💥 Edamam test error:`, error);
    res.status(500).json({
      success: false,
      error: error.message,
      source: 'edamam'
    });
  }
});

// Tasty test route for side-by-side comparison
// GET /api/recipes/tasty-test/check
router.get('/tasty-test/check', async (req, res) => {
  console.log('\n🍳 Testing Tasty connection...');
  
  try {
    // Check if API key is configured
    const apiKeySet = !!process.env.RAPIDAPI_KEY;
    
    if (!apiKeySet) {
      return res.json({
        success: false,
        message: 'Tasty API key not configured',
        credentials: {
          apiKeySet: false
        }
      });
    }
    
    res.json({
      success: true,
      message: 'Tasty API configured',
      credentials: {
        apiKeySet: true
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
      credentials: {
        apiKeySet: !!process.env.RAPIDAPI_KEY
      }
    });
  }
});

// Tasty recipes based on inventory
// GET /api/recipes/tasty-test/suggestions
router.get('/tasty-test/suggestions', authMiddleware.authenticateToken, async (req, res) => {
  const requestId = Math.random().toString(36).substring(7);
  
  try {
    console.log(`\n🍳 Tasty test request: ${requestId}`);
    
    // Get user ID from JWT token
    const userId = req.user?.userId || req.user?.id;
    console.log(`🍳 User ID: ${userId}`);
    
    // Check if Tasty is configured
    if (!process.env.RAPIDAPI_KEY) {
      throw new Error('Tasty API key not configured');
    }
    
    // Get user's inventory
    const inventory = await recipeService.getUserInventory(userId);
    
    if (inventory.length === 0) {
      console.log(`⚠️ No inventory items found for user`);
      return res.json({
        success: true,
        suggestions: [],
        source: 'tasty',
        message: 'No inventory items to search with'
      });
    }
    
    // Prioritize ingredients
    const prioritizedIngredients = recipeService.prioritizeIngredients(inventory);
    const ingredientNames = prioritizedIngredients.map(item => item.item_name);
    
    console.log(`🍳 Searching Tasty with: ${ingredientNames.slice(0, 5).join(', ')}`);
    
    // Import Tasty service
    const tastyService = require('../services/tastyService');
    
    // Get recipes from Tasty
    const tastyRecipes = await tastyService.searchRecipesByIngredients(
      ingredientNames,
      { number: parseInt(req.query.limit) || 8 }
    );
    
    console.log(`🍳 Found ${tastyRecipes.length} Tasty recipes`);
    
    res.json({
      success: true,
      suggestions: tastyRecipes,
      source: 'tasty',
      count: tastyRecipes.length
    });
    
  } catch (error) {
    console.error(`💥 Tasty test error:`, error);
    res.status(500).json({
      success: false,
      error: error.message,
      source: 'tasty'
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
      source_type: source_url?.includes('instagram') ? 'instagram' : 'web',
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
      console.log('[RecipeSave] Recipe already has nutrition data');
      recipeToSave.nutrition = recipe.nutrition;
    } else {
      // Analyze nutrition for the recipe using the original recipe object
      console.log('[RecipeSave] Analyzing nutrition for recipe...');
      try {
        const nutritionData = await nutritionAnalysis.analyzeRecipeNutrition(recipe);
        if (nutritionData) {
          console.log('[RecipeSave] Nutrition analysis successful:', {
            calories: nutritionData.perServing?.calories?.amount,
            confidence: nutritionData.confidence
          });
          recipeToSave.nutrition = nutritionData;
        } else {
          console.log('[RecipeSave] Nutrition analysis returned no data');
          recipeToSave.nutrition = null;
        }
      } catch (nutritionError) {
        console.error('[RecipeSave] Nutrition analysis failed:', nutritionError);
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

// Get detailed recipe information
// GET /api/recipes/:id
// NOTE: This generic route must come AFTER all specific routes
router.get('/:id', authMiddleware.authenticateToken, recipeController.getRecipeDetails);

// Mark ingredients as used when cooking a recipe
// POST /api/recipes/:id/cook
router.post('/:id/cook', authMiddleware.authenticateToken, recipeController.markRecipeCooked);

module.exports = router;