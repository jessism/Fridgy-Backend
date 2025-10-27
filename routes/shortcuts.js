const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const InstagramExtractor = require('../services/instagramExtractor');
const RecipeAIExtractor = require('../services/recipeAIExtractor');
const ApifyInstagramService = require('../services/apifyInstagramService');
const MultiModalExtractor = require('../services/multiModalExtractor');
const pushService = require('../services/pushNotificationService');
const authMiddleware = require('../middleware/auth');
const { getServiceClient } = require('../config/supabase');
const { shortcutImportLimiter } = require('../middleware/rateLimiter');
const { validateShortcutImport, sanitizeRecipeData } = require('../middleware/validation');

// Use service client for database operations (bypasses RLS)
const supabase = getServiceClient();

const instagramExtractor = new InstagramExtractor();
const recipeAI = new RecipeAIExtractor();
const apifyService = new ApifyInstagramService();
const multiModalExtractor = new MultiModalExtractor();

// POST /api/shortcuts/import - Main import endpoint for shortcuts
// Uses multi-modal extraction (Apify + Gemini video analysis) for complete recipe details
// Updated: January 2025 - Enhanced with full video/image analysis for better accuracy
router.post('/import', shortcutImportLimiter, validateShortcutImport, async (req, res) => {
  try {
    const { url, token, caption } = req.body;
    
    console.log('[Shortcuts] Import request received:', { url, hasToken: !!token });
    
    // Validate input
    if (!url || !token) {
      return res.status(400).json({
        success: false,
        error: 'Missing required parameters'
      });
    }
    
    // Validate and get user from token
    const { data: tokenData, error: tokenError } = await supabase
      .from('shortcut_tokens')
      .select('user_id, usage_count, daily_usage_count, daily_usage_reset, daily_limit')
      .eq('token', token)
      .eq('is_active', true)
      .single();

    if (tokenError || !tokenData) {
      console.log('[Shortcuts] Invalid token:', token);
      return res.status(401).json({
        success: false,
        error: 'Invalid or expired token. Please reinstall shortcut.'
      });
    }

    // Check daily limits - use user's custom limit if set, otherwise use default
    const dailyLimit = tokenData.daily_limit || parseInt(process.env.MAX_RECIPES_PER_DAY_FREE) || 5;
    const now = new Date();
    const resetTime = tokenData.daily_usage_reset ? new Date(tokenData.daily_usage_reset) : now;
    
    if (tokenData.daily_usage_count >= dailyLimit && resetTime > now) {
      return res.status(429).json({
        success: false,
        error: `Daily limit reached (${dailyLimit} recipes). Resets at ${resetTime.toLocaleTimeString()}`
      });
    }
    
    // Reset daily counter if needed
    if (resetTime <= now) {
      await supabase
        .from('shortcut_tokens')
        .update({
          daily_usage_count: 0,
          daily_usage_reset: new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString()
        })
        .eq('token', token);
      tokenData.daily_usage_count = 0;
    }

    // Send immediate push notification to provide instant feedback
    try {
      console.log('[Shortcuts] Sending immediate import notification...');
      await pushService.sendToUser(tokenData.user_id, {
        title: 'Importing Recipe',
        body: 'Analyzing Instagram post...',
        icon: '/logo192.png',
        badge: '/logo192.png',
        tag: 'recipe-importing',
        data: {
          url: '/import?importing=true'
        },
        requireInteraction: false
      });
      console.log('[Shortcuts] Immediate notification sent');
    } catch (pushError) {
      console.error('[Shortcuts] Failed to send immediate notification:', pushError);
      // Continue anyway
    }

    // Extract Instagram content using Apify (multi-modal approach)
    console.log(`[Shortcuts] Extracting from URL with multi-modal: ${url}`);
    const apifyData = await apifyService.extractFromUrl(url, tokenData.user_id);

    if (!apifyData.success) {
      console.log('[Shortcuts] Apify extraction failed:', apifyData.error);

      // Send failure notification to user
      try {
        await pushService.sendToUser(tokenData.user_id, {
          title: 'Import Failed',
          body: apifyData.error || 'Could not access Instagram post. Please try again.',
          icon: '/logo192.png',
          badge: '/logo192.png',
          tag: 'recipe-import-failed',
          data: {
            url: '/import'
          },
          requireInteraction: false
        });
      } catch (pushError) {
        console.error('[Shortcuts] Failed to send error notification:', pushError);
      }

      return res.status(400).json({
        success: false,
        error: apifyData.error || 'Failed to extract Instagram content',
        limitExceeded: apifyData.limitExceeded,
        isTimeout: apifyData.isTimeout || false
      });
    }

    console.log('[Shortcuts] Apify extraction result:', {
      hasCaption: !!apifyData.caption,
      hasVideo: !!apifyData.videoUrl,
      imageCount: apifyData.images?.length || 0,
      author: apifyData.author?.username
    });

    // Use multi-modal extractor for unified analysis
    console.log('[Shortcuts] Starting multi-modal analysis...');
    const aiResult = await multiModalExtractor.extractWithAllModalities(apifyData);

    console.log('[Shortcuts] Multi-modal extraction result:', {
      success: aiResult.success,
      confidence: aiResult.confidence,
      title: aiResult.recipe?.title,
      ingredientCount: aiResult.recipe?.extendedIngredients?.length,
      sourcesUsed: aiResult.sourcesUsed
    });
    
    // More lenient handling - accept partial recipes with warnings
    if (!aiResult.success) {
      console.log('[Shortcuts] Recipe extraction had low confidence. Full AI result:', aiResult);
      
      // If we have partial data, try to save it anyway
      if (aiResult.partialExtraction && aiResult.recipe) {
        console.log('[Shortcuts] Attempting to save partial recipe extraction');
        
        // Update the recipe title if we have caption info
        if (apifyData.caption) {
          const firstLine = apifyData.caption.split('\n')[0].substring(0, 100);
          if (firstLine && firstLine.length > 5) {
            aiResult.recipe.title = firstLine.replace(/[🍝🌟✨🥗🍕🍔]/g, '').trim() || "Recipe from Instagram";
          }
        }
        
        // Mark as low confidence but continue
        aiResult.success = true;
        aiResult.confidence = 0.3;
        aiResult.extractionNotes = "Partial recipe extraction - please review and edit the saved recipe";
      } else {
        // Complete failure - no data to save
        let errorMessage = 'Could not extract recipe from this post';
        if (aiResult.extractionNotes) {
          errorMessage += `: ${aiResult.extractionNotes}`;
        }
        if (!apifyData.caption || apifyData.caption.length < 50) {
          errorMessage = 'No recipe content found. The Instagram post may not contain a recipe or the caption could not be extracted.';
        }

        // Send failure notification to user
        try {
          await pushService.sendToUser(tokenData.user_id, {
            title: 'Import Failed',
            body: errorMessage,
            icon: '/logo192.png',
            badge: '/logo192.png',
            tag: 'recipe-import-failed',
            data: {
              url: '/import'
            },
            requireInteraction: false
          });
        } catch (pushError) {
          console.error('[Shortcuts] Failed to send error notification:', pushError);
        }

        return res.status(400).json({
          success: false,
          error: errorMessage,
          details: {
            extractionNotes: aiResult.extractionNotes,
            missingInfo: aiResult.missingInfo,
            captionFound: !!apifyData.caption,
            captionLength: apifyData.caption?.length,
            confidence: aiResult.confidence
          }
        });
      }
    }
    
    // Download and store images permanently
    console.log('[Shortcuts] Downloading and storing images...');
    const tempRecipeId = `temp-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    let permanentImageUrl = null;
    const primaryImageUrl = aiResult.recipe.image || apifyData.images?.[0]?.url;

    if (primaryImageUrl && primaryImageUrl.startsWith('http')) {
      console.log('[Shortcuts] Downloading primary image...');
      permanentImageUrl = await apifyService.downloadInstagramImage(
        primaryImageUrl,
        tempRecipeId,
        tokenData.user_id,
        apifyData
      );

      if (permanentImageUrl) {
        console.log('[Shortcuts] ✅ Image saved:', permanentImageUrl);
      } else {
        console.log('[Shortcuts] ⚠️ Image download failed - using placeholder');
        permanentImageUrl = null;
      }
    }

    const PLACEHOLDER_IMAGE = 'https://images.unsplash.com/photo-1546069901-ba9599a7e63c?w=400';
    const finalImageUrl = permanentImageUrl || PLACEHOLDER_IMAGE;

    // Sanitize and transform recipe data
    const sanitizedRecipe = sanitizeRecipeData({
      ...aiResult.recipe,
      source_url: url,
      source_author: apifyData.author?.username,
      source_author_image: apifyData.author?.profilePic,
      image: finalImageUrl
    });
    
    const transformedRecipe = {
      user_id: tokenData.user_id,
      source_type: 'instagram',
      source_url: url,
      import_method: 'ios_shortcut',

      // Core recipe data
      title: sanitizedRecipe.title || 'Recipe from Instagram',
      summary: sanitizedRecipe.summary || '',
      image: sanitizedRecipe.image,

      // Recipe details
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

      // Additional arrays
      cuisines: sanitizedRecipe.cuisines || [],
      dishTypes: sanitizedRecipe.dishTypes || [],
      diets: sanitizedRecipe.diets || [],

      // Extraction metadata
      extraction_confidence: aiResult.confidence,
      extraction_notes: aiResult.extractionNotes || `Multi-modal extraction via iOS shortcut`,
      missing_info: aiResult.missingInfo || [],
      ai_model_used: 'gemini-2.0-flash',

      // Source attribution
      source_author: sanitizedRecipe.source_author,
      source_author_image: sanitizedRecipe.source_author_image,

      // Nutrition
      nutrition: null
    };
    
    // Save recipe to database
    const { data: savedRecipe, error: saveError } = await supabase
      .from('saved_recipes')
      .insert(transformedRecipe)
      .select()
      .single();
    
    if (saveError) {
      console.error('[Shortcuts] Save error:', saveError);
      throw saveError;
    }
    
    // Update token usage
    await supabase
      .from('shortcut_tokens')
      .update({
        usage_count: tokenData.usage_count + 1,
        daily_usage_count: tokenData.daily_usage_count + 1,
        last_used: new Date().toISOString()
      })
      .eq('token', token);
    
    console.log('[Shortcuts] Recipe saved successfully:', {
      id: savedRecipe.id,
      title: savedRecipe.title,
      hasImage: !!savedRecipe.image,
      ingredientCount: savedRecipe.extendedIngredients?.length,
      extractionMethod: 'multi-modal'
    });

    // Send push notification to user's devices
    try {
      console.log('[Shortcuts] Sending push notification to user...');
      await pushService.sendToUser(tokenData.user_id, {
        title: 'Recipe Saved',
        body: savedRecipe.title || 'Your Instagram recipe has been imported',
        icon: savedRecipe.image || '/logo192.png',
        badge: '/logo192.png',
        tag: 'recipe-import',
        data: {
          url: '/saved-recipes',
          recipeId: savedRecipe.id
        },
        requireInteraction: false,
        actions: [
          { action: 'view', title: 'View Recipe' },
          { action: 'dismiss', title: 'Dismiss' }
        ]
      });
      console.log('[Shortcuts] Push notification sent successfully');
    } catch (pushError) {
      console.error('[Shortcuts] Failed to send push notification:', pushError);
      // Don't fail the import if push fails
    }

    // Return success response for shortcut
    res.json({
      success: true,
      recipe: {
        id: savedRecipe.id,
        title: savedRecipe.title,
        image: savedRecipe.image,
        confidence: aiResult.confidence,
        ingredientCount: savedRecipe.extendedIngredients?.length || 0
      },
      message: savedRecipe.title // This shows in notification
    });
    
  } catch (error) {
    console.error('[Shortcuts] Import error:', error);

    // Send failure notification to user
    try {
      await pushService.sendToUser(tokenData.user_id, {
        title: 'Import Failed',
        body: 'Something went wrong. Please try again.',
        icon: '/logo192.png',
        badge: '/logo192.png',
        tag: 'recipe-import-failed',
        data: {
          url: '/import'
        },
        requireInteraction: false
      });
    } catch (pushError) {
      console.error('[Shortcuts] Failed to send error notification:', pushError);
    }

    res.status(500).json({
      success: false,
      error: 'Failed to import recipe. Please try again.'
    });
  }
});

// GET /api/shortcuts/setup - Get user's shortcut configuration
router.get('/setup', authMiddleware.authenticateToken, async (req, res) => {
  try {
    const userId = req.user?.userId || req.user?.id;
    
    console.log('[Shortcuts] Setup request for user:', userId);
    
    // Check for existing token
    let { data: existingToken } = await supabase
      .from('shortcut_tokens')
      .select('*')
      .eq('user_id', userId)
      .eq('is_active', true)
      .single();
    
    let token;
    if (existingToken) {
      token = existingToken.token;
      console.log('[Shortcuts] Found existing token for user');
    } else {
      // Generate new secure token
      const tokenPrefix = process.env.SHORTCUT_TOKEN_PREFIX || 'scut_';
      const randomString = crypto.randomBytes(16).toString('hex');
      token = `${tokenPrefix}${userId.substring(0, 8)}_${randomString}`;
      
      const { data: insertedToken, error } = await supabase
        .from('shortcut_tokens')
        .insert({
          user_id: userId,
          token: token,
          device_info: {
            userAgent: req.headers['user-agent'],
            ip: req.ip
          }
        })
        .select()
        .single();
      
      if (error) {
        console.error('[Shortcuts] Insert error details:', {
          code: error.code,
          message: error.message,
          details: error.details,
          hint: error.hint
        });
        throw error;
      }
      console.log('[Shortcuts] Generated new token for user:', insertedToken?.id);
    }
    
    // Generate shortcut configuration
    const baseUrl = process.env.API_URL || `http://localhost:${process.env.PORT || 5000}`;
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
    const config = {
      token: token,
      apiUrl: `${baseUrl}/api/shortcuts/import`,
      shortcutName: 'Save to Fridgy',
      
      // Shortcut download URL - use .shortcut extension for better iOS handling
      installUrl: `${frontendUrl}/shortcuts/save-to-fridgy.shortcut`,
      
      // Instructions for the shortcut
      instructions: {
        acceptsUrls: true,
        acceptsText: true,
        showNotification: true
      },
      
      usage: existingToken ? {
        totalSaved: existingToken.usage_count,
        lastUsed: existingToken.last_used,
        dailyUsed: existingToken.daily_usage_count,
        dailyLimit: parseInt(process.env.MAX_RECIPES_PER_DAY_FREE) || 5
      } : null
    };
    
    res.json(config);
    
  } catch (error) {
    console.error('[Shortcuts] Setup error:', {
      message: error.message,
      code: error.code,
      details: error.details,
      stack: error.stack
    });
    res.status(500).json({ 
      error: 'Failed to generate shortcut configuration',
      debug: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// POST /api/shortcuts/regenerate - Generate new token
router.post('/regenerate', authMiddleware.authenticateToken, async (req, res) => {
  try {
    const userId = req.user?.userId || req.user?.id;
    
    console.log('[Shortcuts] Regenerating token for user:', userId);
    
    // Deactivate old tokens
    await supabase
      .from('shortcut_tokens')
      .update({ is_active: false })
      .eq('user_id', userId);
    
    // Generate new token
    const tokenPrefix = process.env.SHORTCUT_TOKEN_PREFIX || 'scut_';
    const randomString = crypto.randomBytes(16).toString('hex');
    const newToken = `${tokenPrefix}${userId.substring(0, 8)}_${randomString}`;
    
    await supabase
      .from('shortcut_tokens')
      .insert({
        user_id: userId,
        token: newToken
      });
    
    res.json({ 
      success: true, 
      token: newToken,
      message: 'New token generated. Please reinstall your shortcut.'
    });
    
  } catch (error) {
    console.error('[Shortcuts] Regenerate error:', error);
    res.status(500).json({ error: 'Failed to regenerate token' });
  }
});

// GET /api/shortcuts/test - Test endpoint for development
router.get('/test', async (req, res) => {
  res.json({
    success: true,
    message: 'Shortcuts API is working',
    endpoints: [
      'POST /api/shortcuts/import',
      'GET /api/shortcuts/setup',
      'POST /api/shortcuts/regenerate'
    ],
    features: {
      manualCaptionSupport: true,
      partialExtractionSupport: true, 
      lowConfidenceAcceptance: true,
      enhancedLogging: true,
      detailedErrorMessages: true
    }
  });
});

module.exports = router;