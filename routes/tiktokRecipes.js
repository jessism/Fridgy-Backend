const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/auth');
const { checkImportedRecipeLimit } = require('../middleware/checkLimits');
const tiktokService = require('../services/apifyTikTokService');
const MultiModalExtractor = require('../services/multiModalExtractor');
const NutritionExtractor = require('../services/nutritionExtractor');
const NutritionAnalysisService = require('../services/nutritionAnalysisService');
const { sanitizeRecipeData } = require('../middleware/validation');

// Initialize extractors
const multiModalExtractor = new MultiModalExtractor();
const nutritionExtractor = new NutritionExtractor();
const nutritionAnalysis = new NutritionAnalysisService();

/**
 * Helper to validate TikTok URLs
 */
const isTikTokUrl = (url) => {
  if (!url) return false;
  return /tiktok\.com|vm\.tiktok\.com|vt\.tiktok\.com|m\.tiktok\.com/i.test(url);
};

/**
 * POST /api/tiktok-recipes/multi-modal-extract
 * Extract recipe from TikTok URL using multi-modal AI analysis
 */
router.post('/multi-modal-extract', authMiddleware.authenticateToken, checkImportedRecipeLimit, async (req, res) => {
  try {
    const { url } = req.body;
    const userId = req.user?.userId || req.user?.id;

    console.log('[TikTokMultiModal] Starting multi-modal extraction for user:', userId);
    console.log('[TikTokMultiModal] TikTok URL:', url);

    // Validate URL
    if (!url || !isTikTokUrl(url)) {
      return res.status(400).json({
        success: false,
        error: 'Please provide a valid TikTok URL'
      });
    }

    // Check if Apify is configured
    if (!process.env.APIFY_API_TOKEN) {
      console.log('[TikTokMultiModal] Apify not configured');
      return res.status(503).json({
        success: false,
        error: 'TikTok import service not available - Apify not configured'
      });
    }

    // Extract with Apify for TikTok content
    console.log('[TikTokMultiModal] Fetching TikTok data with Apify...');
    const apifyData = await tiktokService.extractFromUrl(url, userId);

    console.log('[TikTokMultiModal] Author from Apify:', apifyData.author?.username || 'NO USERNAME');

    if (!apifyData.success) {
      console.log('[TikTokMultiModal] Apify extraction failed:', apifyData.error);

      // Special handling for timeouts
      if (apifyData.isTimeout) {
        console.warn('[TikTokMultiModal] Extraction timed out');
        return res.status(408).json({
          success: false,
          error: 'TikTok extraction timed out. This video may be too long or unavailable. Please try a different recipe or try again later.',
          isTimeout: true,
          technicalError: apifyData.technicalError
        });
      }

      // General failure
      return res.status(400).json({
        success: false,
        error: apifyData.error || 'Failed to extract TikTok content',
        limitExceeded: apifyData.limitExceeded,
        isTimeout: false,
        technicalError: apifyData.technicalError
      });
    }

    console.log('[TikTokMultiModal] Apify extraction successful:', {
      hasCaption: !!apifyData.caption,
      hasVideo: !!apifyData.videoUrl,
      videoDuration: apifyData.videoDuration,
      imageCount: apifyData.images?.length || 0
    });

    // Use multi-modal extractor for unified analysis (same as Instagram/Facebook)
    console.log('[TikTokMultiModal] Starting unified multi-modal analysis...');
    const result = await multiModalExtractor.extractWithAllModalities(apifyData);

    if (!result.success || !result.recipe) {
      console.log('[TikTokMultiModal] Extraction failed or incomplete:', {
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

    console.log('[TikTokMultiModal] Extraction successful:', {
      confidence: result.confidence,
      sourcesUsed: result.sourcesUsed,
      processingTime: result.processingTime
    });

    // Download and store images permanently before returning
    console.log('[TikTokMultiModal] Downloading and storing images permanently...');

    const tempRecipeId = `tt-temp-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

    // Download the main image
    let permanentImageUrl = null;
    const primaryImageUrl = result.recipe.image || apifyData.images?.[0]?.url;

    if (primaryImageUrl && primaryImageUrl.startsWith('http')) {
      console.log('[TikTokMultiModal] Downloading primary image:', primaryImageUrl.substring(0, 100) + '...');
      permanentImageUrl = await tiktokService.downloadTikTokImage(
        primaryImageUrl,
        tempRecipeId,
        userId
      );

      if (permanentImageUrl) {
        console.log('[TikTokMultiModal] Primary image saved to Supabase:', permanentImageUrl);
      } else {
        console.log('[TikTokMultiModal] Failed to download primary image - will use placeholder');
        permanentImageUrl = null;
      }
    }

    // Download additional images if available
    const permanentImageUrls = [];
    if (apifyData.images && apifyData.images.length > 0) {
      console.log(`[TikTokMultiModal] Processing ${apifyData.images.length} additional images...`);

      for (let i = 0; i < Math.min(apifyData.images.length, 5); i++) {
        const imgUrl = apifyData.images[i]?.url || apifyData.images[i];
        if (imgUrl && imgUrl.startsWith('http') && imgUrl !== primaryImageUrl) {
          const savedUrl = await tiktokService.downloadTikTokImage(
            imgUrl,
            `${tempRecipeId}-${i}`,
            userId
          );

          if (savedUrl) {
            permanentImageUrls.push(savedUrl);
            console.log(`[TikTokMultiModal] Additional image ${i + 1} saved`);
          } else {
            console.log(`[TikTokMultiModal] Failed to save additional image ${i + 1}`);
          }
        }
      }
    }

    // Use placeholder image if permanent download failed
    const PLACEHOLDER_IMAGE = 'https://images.unsplash.com/photo-1546069901-ba9599a7e63c?w=400';
    const finalImageUrl = permanentImageUrl || PLACEHOLDER_IMAGE;

    if (!permanentImageUrl) {
      console.log('[TikTokMultiModal] Using placeholder image - original download failed');
    }

    // Prepare recipe data with permanent image URLs only
    const sanitizedRecipe = sanitizeRecipeData({
      ...result.recipe,
      source_type: 'tiktok',
      source_url: url,
      source_author: apifyData.author?.username,
      source_author_image: apifyData.author?.profilePic,
      image: finalImageUrl,
      image_urls: permanentImageUrls.length > 0 ? permanentImageUrls : undefined
    });

    // Get nutrition - first try extracting from caption, then fall back to AI estimation
    console.log('[TikTokMultiModal] Getting nutrition for extracted recipe...');

    try {
      let nutritionData = null;

      // STEP 1: Try to extract nutrition from caption (if creator provided it)
      console.log('[TikTokMultiModal] Step 1: Checking caption for nutrition info...');
      const extractedNutrition = await nutritionExtractor.extractFromCaption(apifyData.caption);

      if (extractedNutrition && extractedNutrition.found) {
        console.log('[TikTokMultiModal] Found nutrition in caption from creator!');
        nutritionData = nutritionExtractor.formatNutritionData(extractedNutrition);
      } else {
        // STEP 2: Fall back to AI estimation from ingredients
        console.log('[TikTokMultiModal] Step 2: No nutrition in caption, estimating from ingredients...');
        nutritionData = await nutritionAnalysis.analyzeRecipeNutrition(sanitizedRecipe);

        if (nutritionData) {
          console.log('[TikTokMultiModal] Nutrition estimation successful');
        }
      }

      sanitizedRecipe.nutrition = nutritionData;

    } catch (nutritionError) {
      console.error('[TikTokMultiModal] Nutrition processing failed:', nutritionError.message);
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
      platform: 'tiktok',
      sourceAttribution: result.sourceAttribution || null
    });

  } catch (error) {
    console.error('[TikTokMultiModal] Error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'TikTok multi-modal extraction failed'
    });
  }
});

/**
 * GET /api/tiktok-recipes/apify-usage
 * Get Apify usage stats (SHARED with Instagram/Facebook/YouTube - same limit)
 */
router.get('/apify-usage', authMiddleware.authenticateToken, async (req, res) => {
  try {
    const userId = req.user?.userId || req.user?.id;
    const usage = await tiktokService.getUsageStats(userId);
    return res.json({ success: true, usage });
  } catch (error) {
    console.error('[TikTokRecipes] Error getting usage stats:', error);
    return res.status(500).json({ success: false, error: 'Failed to get usage stats' });
  }
});

module.exports = router;
