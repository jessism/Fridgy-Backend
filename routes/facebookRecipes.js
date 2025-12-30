const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/auth');
const { checkImportedRecipeLimit } = require('../middleware/checkLimits');
const facebookService = require('../services/apifyFacebookService');
const MultiModalExtractor = require('../services/multiModalExtractor');
const NutritionExtractor = require('../services/nutritionExtractor');
const NutritionAnalysisService = require('../services/nutritionAnalysisService');
const { sanitizeRecipeData } = require('../middleware/validation');

// Initialize extractors
const multiModalExtractor = new MultiModalExtractor();
const nutritionExtractor = new NutritionExtractor();
const nutritionAnalysis = new NutritionAnalysisService();

/**
 * Helper to validate Facebook URLs
 */
const isFacebookUrl = (url) => {
  if (!url) return false;
  return /facebook\.com|fb\.watch|m\.facebook\.com/i.test(url);
};

/**
 * POST /api/facebook-recipes/multi-modal-extract
 * Extract recipe from Facebook URL using multi-modal AI analysis
 */
router.post('/multi-modal-extract', authMiddleware.authenticateToken, checkImportedRecipeLimit, async (req, res) => {
  try {
    const { url } = req.body;
    const userId = req.user?.userId || req.user?.id;

    console.log('[FacebookMultiModal] Starting multi-modal extraction for user:', userId);
    console.log('[FacebookMultiModal] Facebook URL:', url);

    // Validate URL
    if (!url || !isFacebookUrl(url)) {
      return res.status(400).json({
        success: false,
        error: 'Please provide a valid Facebook URL'
      });
    }

    // Check if Apify is configured
    if (!process.env.APIFY_API_TOKEN) {
      console.log('[FacebookMultiModal] Apify not configured');
      return res.status(503).json({
        success: false,
        error: 'Facebook import service not available - Apify not configured'
      });
    }

    // Extract with Apify for Facebook content
    console.log('[FacebookMultiModal] Fetching Facebook data with Apify...');
    const apifyData = await facebookService.extractFromUrl(url, userId);

    console.log('[FacebookMultiModal] Author from Apify:', apifyData.author?.username || 'NO USERNAME');

    if (!apifyData.success) {
      console.log('[FacebookMultiModal] Apify extraction failed:', apifyData.error);
      return res.status(400).json({
        success: false,
        error: apifyData.error || 'Failed to extract Facebook content',
        limitExceeded: apifyData.limitExceeded,
        isTimeout: apifyData.isTimeout || false,
        technicalError: apifyData.technicalError
      });
    }

    console.log('[FacebookMultiModal] Apify extraction successful:', {
      hasCaption: !!apifyData.caption,
      hasVideo: !!apifyData.videoUrl,
      videoDuration: apifyData.videoDuration,
      imageCount: apifyData.images?.length || 0
    });

    // Use multi-modal extractor for unified analysis (same as Instagram)
    console.log('[FacebookMultiModal] Starting unified multi-modal analysis...');
    const result = await multiModalExtractor.extractWithAllModalities(apifyData);

    if (!result.success || !result.recipe) {
      console.log('[FacebookMultiModal] Extraction failed or incomplete:', {
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

    console.log('[FacebookMultiModal] Extraction successful:', {
      confidence: result.confidence,
      sourcesUsed: result.sourcesUsed,
      processingTime: result.processingTime
    });

    // Download and store images permanently before returning
    console.log('[FacebookMultiModal] Downloading and storing images permanently...');

    // Generate a unique recipe ID for this import
    const tempRecipeId = `fb-temp-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

    // Download the main image
    let permanentImageUrl = null;
    const primaryImageUrl = result.recipe.image || apifyData.images?.[0]?.url;

    if (primaryImageUrl && primaryImageUrl.startsWith('http')) {
      console.log('[FacebookMultiModal] Downloading primary image:', primaryImageUrl.substring(0, 100) + '...');
      permanentImageUrl = await facebookService.downloadFacebookImage(
        primaryImageUrl,
        tempRecipeId,
        userId
      );

      if (permanentImageUrl) {
        console.log('[FacebookMultiModal] Primary image saved to Supabase:', permanentImageUrl);
      } else {
        console.log('[FacebookMultiModal] Failed to download primary image - will use placeholder');
        permanentImageUrl = null;
      }
    }

    // Download additional images if available
    const permanentImageUrls = [];
    if (apifyData.images && apifyData.images.length > 0) {
      console.log(`[FacebookMultiModal] Processing ${apifyData.images.length} additional images...`);

      for (let i = 0; i < Math.min(apifyData.images.length, 5); i++) {
        const imgUrl = apifyData.images[i]?.url || apifyData.images[i];
        if (imgUrl && imgUrl.startsWith('http') && imgUrl !== primaryImageUrl) {
          const savedUrl = await facebookService.downloadFacebookImage(
            imgUrl,
            `${tempRecipeId}-${i}`,
            userId
          );

          if (savedUrl) {
            permanentImageUrls.push(savedUrl);
            console.log(`[FacebookMultiModal] Additional image ${i + 1} saved`);
          } else {
            console.log(`[FacebookMultiModal] Failed to save additional image ${i + 1}`);
          }
        }
      }
    }

    // Use placeholder image if permanent download failed
    const PLACEHOLDER_IMAGE = 'https://images.unsplash.com/photo-1546069901-ba9599a7e63c?w=400';
    const finalImageUrl = permanentImageUrl || PLACEHOLDER_IMAGE;

    if (!permanentImageUrl) {
      console.log('[FacebookMultiModal] Using placeholder image - original download failed');
    }

    // Prepare recipe data with permanent image URLs only
    const sanitizedRecipe = sanitizeRecipeData({
      ...result.recipe,
      source_type: 'facebook',
      source_url: url,
      source_author: apifyData.author?.username,
      source_author_image: apifyData.author?.profilePic,
      image: finalImageUrl,
      image_urls: permanentImageUrls.length > 0 ? permanentImageUrls : undefined
    });

    // Get nutrition - first try extracting from caption, then fall back to AI estimation
    console.log('[FacebookMultiModal] Getting nutrition for extracted recipe...');

    try {
      let nutritionData = null;

      // STEP 1: Try to extract nutrition from caption (if creator provided it)
      console.log('[FacebookMultiModal] Step 1: Checking caption for nutrition info...');
      const extractedNutrition = await nutritionExtractor.extractFromCaption(apifyData.caption);

      if (extractedNutrition && extractedNutrition.found) {
        console.log('[FacebookMultiModal] Found nutrition in caption from creator!');
        nutritionData = nutritionExtractor.formatNutritionData(extractedNutrition);
      } else {
        // STEP 2: Fall back to AI estimation from ingredients
        console.log('[FacebookMultiModal] Step 2: No nutrition in caption, estimating from ingredients...');
        nutritionData = await nutritionAnalysis.analyzeRecipeNutrition(sanitizedRecipe);

        if (nutritionData) {
          console.log('[FacebookMultiModal] Nutrition estimation successful');
        }
      }

      sanitizedRecipe.nutrition = nutritionData;

    } catch (nutritionError) {
      console.error('[FacebookMultiModal] Nutrition processing failed:', nutritionError.message);
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
      platform: 'facebook',
      sourceAttribution: result.sourceAttribution || null
    });

  } catch (error) {
    console.error('[FacebookMultiModal] Error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Facebook multi-modal extraction failed'
    });
  }
});

/**
 * GET /api/facebook-recipes/apify-usage
 * Get Apify usage stats (SHARED with Instagram - same limit)
 */
router.get('/apify-usage', authMiddleware.authenticateToken, async (req, res) => {
  try {
    const userId = req.user?.userId || req.user?.id;
    const usage = await facebookService.getUsageStats(userId);
    return res.json({ success: true, usage });
  } catch (error) {
    console.error('[FacebookRecipes] Error getting usage stats:', error);
    return res.status(500).json({ success: false, error: 'Failed to get usage stats' });
  }
});

module.exports = router;
