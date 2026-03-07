const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/auth');
const { checkImportedRecipeLimit } = require('../middleware/checkLimits');
const youtubeService = require('../services/apifyYouTubeService');
const MultiModalExtractor = require('../services/multiModalExtractor');
const NutritionExtractor = require('../services/nutritionExtractor');
const NutritionAnalysisService = require('../services/nutritionAnalysisService');
const { sanitizeRecipeData } = require('../middleware/validation');

// Initialize extractors
const multiModalExtractor = new MultiModalExtractor();
const nutritionExtractor = new NutritionExtractor();
const nutritionAnalysis = new NutritionAnalysisService();

/**
 * Helper to validate YouTube URLs
 */
const isYouTubeUrl = (url) => {
  if (!url) return false;
  return /youtube\.com|youtu\.be/i.test(url);
};

/**
 * POST /api/youtube-recipes/multi-modal-extract
 * Extract recipe from YouTube URL using multi-modal AI analysis
 *
 * Request body:
 *   - url: YouTube video URL (youtube.com/watch?v=, youtu.be/, shorts)
 *
 * Response:
 *   - success: boolean
 *   - recipe: Recipe object with ingredients, instructions, etc.
 *   - confidence: AI confidence score
 *   - sourcesUsed: Array of data sources used (description, transcript, thumbnails)
 */
router.post('/multi-modal-extract', authMiddleware.authenticateToken, checkImportedRecipeLimit, async (req, res) => {
  try {
    const { url } = req.body;
    const userId = req.user?.userId || req.user?.id;

    console.log('[YouTubeMultiModal] Starting multi-modal extraction for user:', userId);
    console.log('[YouTubeMultiModal] YouTube URL:', url);

    // Validate URL
    if (!url || !isYouTubeUrl(url)) {
      return res.status(400).json({
        success: false,
        error: 'Please provide a valid YouTube URL (youtube.com, youtu.be, or shorts)'
      });
    }

    // Check if Apify is configured
    if (!process.env.APIFY_API_TOKEN) {
      console.log('[YouTubeMultiModal] Apify not configured');
      return res.status(503).json({
        success: false,
        error: 'YouTube import service not available - Apify not configured'
      });
    }

    // Extract with Apify for YouTube content
    console.log('[YouTubeMultiModal] Fetching YouTube data with Apify...');
    const apifyData = await youtubeService.extractFromUrl(url, userId);

    console.log('[YouTubeMultiModal] Author from Apify:', apifyData.author?.username || 'NO USERNAME');

    if (!apifyData.success) {
      console.log('[YouTubeMultiModal] Apify extraction failed:', apifyData.error);
      return res.status(400).json({
        success: false,
        error: apifyData.error || 'Failed to extract YouTube content',
        limitExceeded: apifyData.limitExceeded,
        durationExceeded: apifyData.durationExceeded,
        actualDuration: apifyData.actualDuration,
        isTimeout: apifyData.isTimeout || false,
        technicalError: apifyData.technicalError
      });
    }

    console.log('[YouTubeMultiModal] Apify extraction successful:', {
      hasDescription: !!apifyData.caption,
      hasTranscript: !!apifyData.transcript,
      hasVideo: !!apifyData.videoUrl,
      videoDuration: apifyData.videoDuration,
      imageCount: apifyData.images?.length || 0,
      isShort: apifyData.isShort
    });

    // Use multi-modal extractor for unified analysis (same as Instagram/Facebook)
    console.log('[YouTubeMultiModal] Starting unified multi-modal analysis...');
    const result = await multiModalExtractor.extractWithAllModalities(apifyData);

    if (!result.success || !result.recipe) {
      console.log('[YouTubeMultiModal] Extraction failed or incomplete:', {
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

    console.log('[YouTubeMultiModal] Extraction successful:', {
      confidence: result.confidence,
      sourcesUsed: result.sourcesUsed,
      processingTime: result.processingTime
    });

    // Download and store thumbnails permanently before returning
    console.log('[YouTubeMultiModal] Downloading and storing thumbnails permanently...');

    // Generate a unique recipe ID for this import
    const tempRecipeId = `yt-temp-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

    // Download the main thumbnail
    let permanentImageUrl = null;
    const primaryImageUrl = result.recipe.image || apifyData.images?.[0]?.url;

    if (primaryImageUrl && primaryImageUrl.startsWith('http')) {
      console.log('[YouTubeMultiModal] Downloading primary thumbnail:', primaryImageUrl.substring(0, 100) + '...');
      permanentImageUrl = await youtubeService.downloadYouTubeThumbnail(
        primaryImageUrl,
        tempRecipeId,
        userId
      );

      if (permanentImageUrl) {
        console.log('[YouTubeMultiModal] Primary thumbnail saved to Supabase:', permanentImageUrl);
      } else {
        console.log('[YouTubeMultiModal] Failed to download primary thumbnail - will use placeholder');
        permanentImageUrl = null;
      }
    }

    // Download additional thumbnails if available
    const permanentImageUrls = [];
    if (apifyData.images && apifyData.images.length > 1) {
      console.log(`[YouTubeMultiModal] Processing ${apifyData.images.length} thumbnails...`);

      for (let i = 1; i < Math.min(apifyData.images.length, 3); i++) {
        const imgUrl = apifyData.images[i]?.url || apifyData.images[i];
        if (imgUrl && imgUrl.startsWith('http') && imgUrl !== primaryImageUrl) {
          const savedUrl = await youtubeService.downloadYouTubeThumbnail(
            imgUrl,
            `${tempRecipeId}-${i}`,
            userId
          );

          if (savedUrl) {
            permanentImageUrls.push(savedUrl);
            console.log(`[YouTubeMultiModal] Additional thumbnail ${i} saved`);
          } else {
            console.log(`[YouTubeMultiModal] Failed to save additional thumbnail ${i}`);
          }
        }
      }
    }

    // Use placeholder image if permanent download failed
    const PLACEHOLDER_IMAGE = 'https://images.unsplash.com/photo-1546069901-ba9599a7e63c?w=400';
    const finalImageUrl = permanentImageUrl || PLACEHOLDER_IMAGE;

    if (!permanentImageUrl) {
      console.log('[YouTubeMultiModal] Using placeholder image - original download failed');
    }

    // Prepare recipe data with permanent image URLs only
    const sanitizedRecipe = sanitizeRecipeData({
      ...result.recipe,
      source_type: 'youtube',
      source_url: url,
      source_author: apifyData.author?.username,
      source_author_image: apifyData.author?.profilePic,
      image: finalImageUrl,
      image_urls: permanentImageUrls.length > 0 ? permanentImageUrls : undefined,
      video_duration: apifyData.videoDuration,
      is_short: apifyData.isShort,
      channel_url: apifyData.channelUrl,
      channel_subscribers: apifyData.channelSubscribers
    });

    // Get nutrition - first try extracting from description, then fall back to AI estimation
    console.log('[YouTubeMultiModal] Getting nutrition for extracted recipe...');

    try {
      let nutritionData = null;

      // STEP 1: Try to extract nutrition from description (if creator provided it)
      console.log('[YouTubeMultiModal] Step 1: Checking description for nutrition info...');
      const extractedNutrition = await nutritionExtractor.extractFromCaption(apifyData.caption);

      if (extractedNutrition && extractedNutrition.found) {
        console.log('[YouTubeMultiModal] Found nutrition in description from creator!');
        nutritionData = nutritionExtractor.formatNutritionData(extractedNutrition);
      } else {
        // STEP 2: Fall back to AI estimation from ingredients
        console.log('[YouTubeMultiModal] Step 2: No nutrition in description, estimating from ingredients...');
        nutritionData = await nutritionAnalysis.analyzeRecipeNutrition(sanitizedRecipe);

        if (nutritionData) {
          console.log('[YouTubeMultiModal] Nutrition estimation successful');
        }
      }

      sanitizedRecipe.nutrition = nutritionData;

    } catch (nutritionError) {
      console.error('[YouTubeMultiModal] Nutrition processing failed:', nutritionError.message);
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
      platform: 'youtube',
      isShort: apifyData.isShort,
      hasTranscript: !!apifyData.transcript,
      sourceAttribution: result.sourceAttribution || null
    });

  } catch (error) {
    console.error('[YouTubeMultiModal] Error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'YouTube multi-modal extraction failed'
    });
  }
});

/**
 * GET /api/youtube-recipes/apify-usage
 * Get Apify usage stats (SHARED with Instagram and Facebook - same limit)
 *
 * Response:
 *   - success: boolean
 *   - usage: { used: number, limit: number, remaining: number, percentage: number }
 *   - note: string (reminder that limit is shared across platforms)
 */
router.get('/apify-usage', authMiddleware.authenticateToken, async (req, res) => {
  try {
    const userId = req.user?.userId || req.user?.id;
    const usage = await youtubeService.getUsageStats(userId);

    return res.json({
      success: true,
      usage: usage,
      note: 'Import limit is shared across Instagram, Facebook, and YouTube'
    });
  } catch (error) {
    console.error('[YouTubeRecipes] Error getting usage stats:', error);
    return res.status(500).json({
      success: false,
      error: 'Failed to get usage stats'
    });
  }
});

module.exports = router;
