const mealAnalysisService = require('../services/mealAnalysisService');
const inventoryDeductionService = require('../services/inventoryDeductionService');
const streakService = require('../services/streakService');
const mealImageService = require('../services/mealImageService');
const { incrementUsageCounter, decrementUsageCounter } = require('../middleware/checkLimits');
const { invalidateInsights } = require('../services/insightsService');
const jwt = require('jsonwebtoken');
const moment = require('moment-timezone');
const { getServiceClient } = require('../config/supabase');

// JWT secret
const JWT_SECRET = process.env.JWT_SECRET || 'your-super-secret-jwt-key-change-in-production';

// Helper function to get user ID from token
const getUserIdFromToken = (req) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  
  if (!token) {
    throw new Error('No token provided');
  }
  
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    return decoded.userId;
  } catch (error) {
    throw new Error('Invalid token');
  }
};

/**
 * Upload a meal photo to Supabase Storage, retrying once on transient
 * failure. Non-fatal: returns the public URL, or null if both attempts
 * fail (logged as MEAL_PHOTO_UPLOAD_FAILED so it's greppable in Railway).
 */
async function uploadMealPhoto(userId, file, requestId, filePrefix = '') {
  const timestamp = Date.now();
  const randomId = Math.random().toString(36).substring(7);
  const fileName = `${userId}/${filePrefix}${timestamp}_${randomId}.jpg`;
  const supabase = getServiceClient();

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      console.log(`🍽️ [${requestId}] Uploading image to Storage (attempt ${attempt}): ${fileName}`);

      const { error: uploadError } = await supabase.storage
        .from('meal-photos')
        .upload(fileName, file.buffer, {
          contentType: file.mimetype || 'image/jpeg',
          upsert: attempt > 1
        });

      if (uploadError) {
        throw new Error(uploadError.message || JSON.stringify(uploadError));
      }

      const { data: urlData } = supabase.storage
        .from('meal-photos')
        .getPublicUrl(fileName);

      console.log(`🍽️ [${requestId}] Image uploaded successfully: ${urlData.publicUrl}`);
      return urlData.publicUrl;
    } catch (storageError) {
      if (attempt < 2) {
        console.warn(`🍽️ [${requestId}] Storage upload attempt ${attempt} failed, retrying:`, storageError.message);
        await new Promise(resolve => setTimeout(resolve, 500));
      } else {
        console.error(`❌ [${requestId}] MEAL_PHOTO_UPLOAD_FAILED user=${userId} file=${fileName}:`, storageError.message);
      }
    }
  }
  return null;
}

/**
 * Shared meal-photo processing: upload to Storage + AI analysis.
 * Used by both the synchronous /scan endpoint and the async scan job.
 */
async function performMealScan(userId, file, requestId) {
  // Upload image to Supabase Storage (non-fatal on failure)
  const imageUrl = await uploadMealPhoto(userId, file, requestId);

  // Analyze the meal image
  const analysisResult = await mealAnalysisService.analyzeMealImage(file.buffer);
  const detectedIngredients = analysisResult.ingredients || analysisResult;
  const mealName = analysisResult.meal_name || 'Home-cooked Meal';

  console.log(`🍽️ [${requestId}] Meal name: ${mealName}`);
  console.log(`🍽️ [${requestId}] Detected ${detectedIngredients.length} ingredients`);

  return { mealName, ingredients: detectedIngredients, imageUrl };
}

/**
 * Background processor for async meal scan jobs.
 */
async function processMealScanJob(jobId, userId, file) {
  const previewJobService = require('../services/previewJobService');
  try {
    const { mealName, ingredients, imageUrl } = await performMealScan(userId, file, jobId);

    const result = { meal_name: mealName, ingredients, imageUrl };

    await previewJobService.completePreviewJob(jobId, userId, result, 'meal_scan', {
      title: 'Meal analysis ready!',
      body: `"${mealName}" — tap to review your ingredients`,
      tag: 'meal-scan',
      data: {
        screen: `/(main)/meal-capture?jobId=${jobId}`,
        type: 'meal_scan_complete',
        jobId,
      },
      requireInteraction: false,
    });
    console.log(`✅ [${jobId}] Async meal scan complete`);
  } catch (error) {
    console.error(`❌ [${jobId}] Async meal scan failed:`, error.message);
    await previewJobService.failPreviewJob(jobId, userId, 'Failed to analyze meal', 'meal_scan', {
      title: 'Meal scan failed',
      body: "We couldn't analyze your meal photo. Please try again.",
      tag: 'meal-scan',
      data: {
        screen: `/(main)/meal-capture?jobId=${jobId}`,
        type: 'meal_scan_failed',
        jobId,
      },
      requireInteraction: false,
    });
  }
}

// Preview jobs have no deadline wrapper (runImportWithDeadline is URL-import
// only), so cap each AI call here. A hung OpenRouter call otherwise leaves the
// phone polling for the full 3 minutes.
function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

const TEXT_ANALYSIS_TIMEOUT_MS = 60 * 1000;
const TEXT_IMAGE_TIMEOUT_MS = 40 * 1000; // phone polls for 45s after analysis
// Column bounds (migration 088): INTEGER, NUMERIC(7,1), NUMERIC(8,2). Anything
// past these is a model hallucination, not a meal.
const MAX_CALORIES = 50000;
const MAX_MACRO_G = 10000;
const MAX_PRICE_USD = 10000;
const TEXT_DESCRIPTION_MIN = 3;
const TEXT_DESCRIPTION_MAX = 300;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\x00-\x1F\x7F]/g;

/**
 * Background processor for "log meal from text" jobs. Two phases so the user
 * never waits on the picture:
 *   1. analysis → completePreviewJob (phone shows the review screen)
 *   2. image    → updateResult      (phone polls and swaps in the photo)
 * Quota is charged between them, only once analysis has succeeded.
 */
async function processMealTextJob(jobId, userId, description, mealSource) {
  const previewJobService = require('../services/previewJobService');
  const deepLink = `/(main)/meal-capture?jobId=${jobId}`;

  let analysis;
  try {
    analysis = await withTimeout(
      mealAnalysisService.analyzeMealText(description, { mealSource }),
      TEXT_ANALYSIS_TIMEOUT_MS,
      'Text meal analysis'
    );
  } catch (error) {
    const noFood = error.message === 'NO_INGREDIENTS';
    console.error(`❌ [${jobId}] Text meal analysis failed:`, error.message);
    // Charged at request time (see analyzeMealTextAsync); a failed AI call
    // must not cost the user one of their 3.
    await decrementUsageCounter(userId, 'meal_text');
    await previewJobService.failPreviewJob(
      jobId,
      userId,
      noFood
        ? "We couldn't identify a meal from that description. Try adding a bit more detail."
        : 'Failed to analyze meal',
      'meal_text',
      {
        title: 'Meal analysis failed',
        body: noFood ? 'Try adding a bit more detail to your description.' : "We couldn't analyze that meal. Please try again.",
        tag: 'meal-text',
        data: { screen: deepLink, type: 'meal_text_failed', jobId },
        requireInteraction: false,
      }
    );
    return;
  }

  const cachedImage = await mealImageService.getCachedMealImage(analysis.meal_name);

  const result = {
    inputMode: 'text',
    mealSource,
    description,
    ...analysis,
    imageUrl: cachedImage,
    imageStatus: cachedImage ? 'ready' : 'pending',
  };

  await previewJobService.completePreviewJob(jobId, userId, result, 'meal_text', {
    title: 'Meal analysis ready!',
    body: `"${analysis.meal_name}" — tap to review`,
    tag: 'meal-text',
    data: { screen: deepLink, type: 'meal_text_complete', jobId },
    requireInteraction: false,
  });
  console.log(`✅ [${jobId}] Text meal analysis complete (image ${result.imageStatus})`);

  if (cachedImage) return;

  const imageUrl = await withTimeout(
    mealImageService.generateMealImage({
      mealName: analysis.meal_name,
      keyIngredients: analysis.key_ingredients,
      cuisine: analysis.cuisine,
    }),
    TEXT_IMAGE_TIMEOUT_MS,
    'Meal image generation'
  ).catch(err => {
    console.warn(`⚠️ [${jobId}] ${err.message}`);
    return null;
  });

  await previewJobService.updateResult(jobId, userId, {
    imageUrl: imageUrl || null,
    imageStatus: imageUrl ? 'ready' : 'failed',
  });
  console.log(`🖼️ [${jobId}] Text meal image ${imageUrl ? 'ready' : 'failed'}`);
}

/**
 * Clean a typed description. Returns null when it's unusable.
 */
function sanitizeDescription(raw) {
  if (typeof raw !== 'string') return null;
  const cleaned = raw
    .replace(CONTROL_CHARS, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (cleaned.length < TEXT_DESCRIPTION_MIN || cleaned.length > TEXT_DESCRIPTION_MAX) return null;
  return cleaned;
}

const clampRange = (v, max) => {
  const n = parseFloat(v);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.min(n, max);
};

const mealController = {
  /**
   * Analyze a typed meal description as a background job.
   * POST /api/meals/text-async  { description, mealSource }
   * Gated by checkMealTextLimit (3/week free); the counter is charged inside
   * the job only after analysis succeeds, so a failed AI call costs nothing.
   */
  async analyzeMealTextAsync(req, res) {
    try {
      const userId = getUserIdFromToken(req);

      const description = sanitizeDescription(req.body?.description);
      if (!description) {
        return res.status(400).json({
          success: false,
          error: 'INVALID_DESCRIPTION',
          message: `Describe your meal in ${TEXT_DESCRIPTION_MIN}-${TEXT_DESCRIPTION_MAX} characters.`
        });
      }

      const mealSource = req.body?.mealSource === 'dine_out' ? 'dine_out' : 'eat_in';

      const previewJobService = require('../services/previewJobService');
      const jobId = await previewJobService.createPreviewJob(userId, 'meal_text');

      // Charge now, not after analysis: incrementUsage drops the 5-minute
      // limit cache, so a burst of taps can't all pass on a stale check.
      // The job refunds it if the AI call fails.
      await incrementUsageCounter(userId, 'meal_text');

      console.log(`🍽️ [${jobId}] Text meal analysis started (${description.length} chars, ${mealSource})`);

      res.json({ success: true, jobId, status: 'processing' });

      processMealTextJob(jobId, userId, description, mealSource).catch(err => {
        console.error(`[MealTextJob] Job ${jobId} unhandled error:`, err);
      });
    } catch (error) {
      console.error('[MealTextJob] Failed to start:', error);
      const statusCode = error.message.includes('token') ? 401 : 500;
      res.status(statusCode).json({
        success: false,
        error: error.message.includes('token') ? 'Authentication required' : 'Failed to start meal analysis'
      });
    }
  },

  /**
   * Scan and analyze a meal photo (synchronous — kept for older app builds)
   */
  async scanMeal(req, res) {
    const requestId = Math.random().toString(36).substring(7);

    try {
      console.log(`\n🍽️ ================== MEAL SCAN START ==================`);
      console.log(`🍽️ REQUEST ID: ${requestId}`);

      // Get user ID from token
      const userId = getUserIdFromToken(req);
      console.log(`🍽️ [${requestId}] User ID: ${userId}`);

      // Check if image was uploaded
      if (!req.file) {
        throw new Error('No image file provided');
      }

      console.log(`🍽️ [${requestId}] Image size: ${req.file.size} bytes`);

      const { mealName, ingredients, imageUrl } = await performMealScan(userId, req.file, requestId);

      res.json({
        success: true,
        meal_name: mealName,  // Include the meal name
        ingredients: ingredients,
        imageUrl: imageUrl,  // Include the storage URL
        requestId: requestId,
        timestamp: new Date().toISOString()
      });

      console.log(`✅ [${requestId}] Meal scan complete`);
      console.log(`✅ ================== MEAL SCAN END ==================\n`);

    } catch (error) {
      console.error(`❌ [${requestId}] Meal scan error:`, error);
      
      const statusCode = error.message.includes('token') ? 401 : 500;
      
      res.status(statusCode).json({
        success: false,
        error: error.message.includes('token') ? 'Authentication required' : 'Failed to analyze meal',
        requestId: requestId,
        timestamp: new Date().toISOString()
      });
    }
  },

  /**
   * Async meal scan: creates a job, responds immediately, processes in the
   * background. Poll via GET /api/recipes/import-status/:jobId — the completed
   * job carries { meal_name, ingredients, imageUrl } for the review screen.
   * Survives the app being backgrounded mid-analysis.
   */
  async scanMealAsync(req, res) {
    try {
      const userId = getUserIdFromToken(req);

      if (!req.file) {
        return res.status(400).json({ success: false, error: 'No image file provided' });
      }

      const previewJobService = require('../services/previewJobService');
      const jobId = await previewJobService.createPreviewJob(userId, 'meal_scan');

      console.log(`🍽️ [${jobId}] Async meal scan started (${req.file.size} bytes)`);

      // Return immediately — the phone polls for the result
      res.json({ success: true, jobId, status: 'processing' });

      processMealScanJob(jobId, userId, req.file).catch(err => {
        console.error(`[MealScanJob] Job ${jobId} unhandled error:`, err);
      });
    } catch (error) {
      console.error('[MealScanJob] Failed to start:', error);
      const statusCode = error.message.includes('token') ? 401 : 500;
      res.status(statusCode).json({
        success: false,
        error: error.message.includes('token') ? 'Authentication required' : 'Failed to start meal scan'
      });
    }
  },

  /**
   * Log a meal and deduct ingredients from inventory
   */
  async logMeal(req, res) {
    const requestId = Math.random().toString(36).substring(7);
    
    try {
      console.log(`\n📝 ================== MEAL LOG START ==================`);
      console.log(`📝 REQUEST ID: ${requestId}`);
      
      // Get user ID from token
      const userId = getUserIdFromToken(req);
      console.log(`📝 [${requestId}] User ID from JWT: ${userId}`);
      console.log(`📝 [${requestId}] User ID type: ${typeof userId}`);
      
      const {
        ingredients, mealType, targetDate, mealName,
        // Text-meal fields (absent from photo logs and older builds)
        source = 'photo', isDineOut = false, description,
        totalCalories, macros, estimatedPriceUsd,
        analysisMealName, // the AI's dish name — the generated picture is cached under it
      } = req.body;
      let { imageUrl } = req.body;
      
      // Debug log the received data
      console.log(`📝 [${requestId}] Received imageUrl: ${imageUrl}`);
      console.log(`📝 [${requestId}] ImageUrl type: ${typeof imageUrl}`);
      console.log(`📝 [${requestId}] ImageUrl length: ${imageUrl ? imageUrl.length : 0}`);
      console.log(`📝 [${requestId}] Meal name: ${mealName}`);
      
      // Validate input
      if (!ingredients || !Array.isArray(ingredients) || ingredients.length === 0) {
        throw new Error('No ingredients provided');
      }
      
      console.log(`📝 [${requestId}] Logging ${ingredients.length} ingredients for ${mealType || 'unspecified meal'}${targetDate ? ` on ${targetDate}` : ''}`);
      
      // Validate meal type if provided
      const validMealTypes = ['breakfast', 'lunch', 'dinner', 'snack'];
      if (mealType && !validMealTypes.includes(mealType)) {
        throw new Error('Invalid meal type. Must be breakfast, lunch, dinner, or snack');
      }
      
      // Validate target date if provided
      let logDate = null;
      if (targetDate) {
        logDate = new Date(targetDate);
        if (isNaN(logDate.getTime())) {
          throw new Error('Invalid target date format');
        }
      }
      
      // Extra meal_logs columns (migration 088). Only keys the client actually
      // sent are written, so a photo log's insert is byte-identical to before.
      const isText = source === 'text';
      const extras = {};
      if (isText) {
        extras.source = 'text';
        if (typeof description === 'string' && description.trim()) {
          extras.description = description.trim().slice(0, 300);
        }
      }

      // Totals: trust the submitted ingredients when they carry the numbers
      // (the user may have toggled some off), else the client's dish totals.
      const hasIngredientMacros = ingredients.some(i => i && (i.protein_g != null || i.carbs_g != null || i.fat_g != null));
      const sumField = (key) => ingredients.reduce((t, i) => t + (parseFloat(i?.[key]) || 0), 0);
      const round1 = (n) => Math.round(n * 10) / 10;

      if (isText || totalCalories != null) {
        const submittedCalories = sumField('calories');
        const totalCal = clampRange(submittedCalories > 0 ? submittedCalories : totalCalories, MAX_CALORIES);
        if (totalCal != null) extras.total_calories = Math.round(totalCal);
      }

      const macroSource = hasIngredientMacros
        ? { protein_g: sumField('protein_g'), carbs_g: sumField('carbs_g'), fat_g: sumField('fat_g') }
        : (macros && typeof macros === 'object' ? macros : null);
      if (macroSource) {
        for (const key of ['protein_g', 'carbs_g', 'fat_g']) {
          const v = clampRange(macroSource[key], MAX_MACRO_G);
          if (v != null) extras[key] = round1(v);
        }
      }

      const price = clampRange(estimatedPriceUsd, MAX_PRICE_USD);
      if (price != null) extras.estimated_price_usd = Math.round(price * 100) / 100;

      // The generated picture may have finished after the user tapped Log. It
      // is cached under the AI's name; the user may have renamed the dish.
      if (isText && !imageUrl) {
        for (const candidate of [analysisMealName, mealName]) {
          if (!candidate) continue;
          imageUrl = await mealImageService.getCachedMealImage(candidate);
          if (imageUrl) break;
        }
      }

      if (isDineOut === true) {
        // Dine-out: nothing leaves the pantry. Save the real ingredients (not
        // the photo flow's 'Total Calories' pseudo-item) so detail can list them.
        const supabase = getServiceClient();
        const saved = await inventoryDeductionService.logMealTransaction(
          supabase, userId, ingredients, [], imageUrl || null, mealType, logDate, mealName,
          { ...extras, is_dine_out: true }
        );
        invalidateInsights(userId); // deductFromInventory does this for eat-in
        console.log(`📝 [${requestId}] Dine-out meal saved (no deduction)`);

        res.json({
          success: true,
          results: { deducted: [], errors: [], summary: { successfulDeductions: 0, failedDeductions: 0, totalIngredients: ingredients.length } },
          message: 'Dine-out meal logged',
          meal: saved?.[0] || null,
          requestId: requestId,
          timestamp: new Date().toISOString()
        });
      } else {
        // Deduct ingredients from inventory and save meal log
        const deductionResult = await inventoryDeductionService.deductFromInventory(
          userId,
          ingredients,
          imageUrl,  // Pass image URL to save in meal log
          mealType,  // Pass meal type to save in meal log
          logDate,   // Pass target date to save in meal log
          mealName,  // Pass meal name to save in meal log
          extras
        );

        console.log(`📝 [${requestId}] Deduction results:`, deductionResult.summary);

        // Return the results
        res.json({
          success: true,
          results: deductionResult,
          message: `Successfully logged meal with ${deductionResult.summary.successfulDeductions} items deducted`,
          requestId: requestId,
          timestamp: new Date().toISOString()
        });
      }

      // Streak: fire-and-forget; back-dated logs (targetDate ≠ today) don't count
      streakService.recordActionForDate(userId, 'meal_log', targetDate).catch(err => {
        console.error(`[Streak] Failed to record meal_log:`, err.message);
      });

      console.log(`✅ [${requestId}] Meal log complete`);
      console.log(`✅ ================== MEAL LOG END ==================\n`);
      
    } catch (error) {
      console.error(`❌ [${requestId}] Meal log error:`, error);
      
      const statusCode = error.message.includes('token') ? 401 : 500;
      
      res.status(statusCode).json({
        success: false,
        error: error.message.includes('token') ? 'Authentication required' : `Failed to log meal: ${error.message}`,
        details: error.message,  // Include full error details
        requestId: requestId,
        timestamp: new Date().toISOString()
      });
    }
  },

  /**
   * Get meal history for a user
   */
  async getMealHistory(req, res) {
    const requestId = Math.random().toString(36).substring(7);
    
    try {
      console.log(`\n📚 ================== MEAL HISTORY START ==================`);
      console.log(`📚 REQUEST ID: ${requestId}`);
      
      // Get user ID from token
      const userId = getUserIdFromToken(req);
      console.log(`📚 [${requestId}] User ID: ${userId}`);
      
      // Get date filter from query params if provided
      const { date } = req.query;
      console.log(`📚 [${requestId}] Date filter: ${date || 'none'}`);
      
      const supabase = getServiceClient();
      
      // Fetch user's timezone
      const { data: userData, error: userError } = await supabase
        .from('users')
        .select('timezone')
        .eq('id', userId)
        .single();
      
      if (userError) {
        console.error(`📚 [${requestId}] Error fetching user timezone:`, userError);
      }
      
      const userTimezone = userData?.timezone || 'America/Los_Angeles';
      console.log(`📚 [${requestId}] User timezone: ${userTimezone}`);
      
      // Build query
      let query = supabase
        .from('meal_logs')
        .select('*')
        .eq('user_id', userId);
      
      // Apply date filter if provided
      if (date) {
        // Convert user's local date to UTC range based on their timezone
        // date format: YYYY-MM-DD (in user's local timezone)
        const startOfDayLocal = moment.tz(date, userTimezone).startOf('day');
        const endOfDayLocal = moment.tz(date, userTimezone).endOf('day');
        
        // Convert to UTC for database query
        const startOfDayUTC = startOfDayLocal.utc().toISOString();
        const endOfDayUTC = endOfDayLocal.utc().toISOString();
        
        console.log(`📚 [${requestId}] Date range in ${userTimezone}: ${startOfDayLocal.format()} to ${endOfDayLocal.format()}`);
        console.log(`📚 [${requestId}] Date range in UTC: ${startOfDayUTC} to ${endOfDayUTC}`);
        
        query = query
          .gte('logged_at', startOfDayUTC)
          .lte('logged_at', endOfDayUTC);
      }
      
      // Execute query with ordering and limit
      const { data: mealHistory, error } = await query
        .order('logged_at', { ascending: false })
        .limit(date ? 100 : 50); // More results for single day
      
      if (error) {
        throw error;
      }
      
      console.log(`📚 [${requestId}] Found ${mealHistory?.length || 0} meal logs${date ? ` for date ${date}` : ''}`);
      
      res.json({
        success: true,
        meals: mealHistory || [],
        requestId: requestId,
        timestamp: new Date().toISOString()
      });
      
      console.log(`✅ [${requestId}] Meal history retrieved`);
      console.log(`✅ ================== MEAL HISTORY END ==================\n`);
      
    } catch (error) {
      console.error(`❌ [${requestId}] Meal history error:`, error);
      
      const statusCode = error.message.includes('token') ? 401 : 500;
      
      res.status(statusCode).json({
        success: false,
        error: error.message.includes('token') ? 'Authentication required' : 'Failed to get meal history',
        requestId: requestId,
        timestamp: new Date().toISOString()
      });
    }
  },

  /**
   * Update a meal
   * @route PUT /api/meals/:id
   */
  async updateMeal(req, res) {
    const requestId = Math.random().toString(36).substring(7);
    
    try {
      console.log(`\n✏️ ================== MEAL UPDATE START ==================`);
      console.log(`✏️ REQUEST ID: ${requestId}`);
      
      const userId = getUserIdFromToken(req);
      const mealId = req.params.id;
      const { meal_name, ingredients_logged } = req.body;
      
      console.log(`✏️ [${requestId}] User ID: ${userId}`);
      console.log(`✏️ [${requestId}] Meal ID: ${mealId}`);
      
      const supabase = getServiceClient();
      
      // First check if the meal belongs to the user
      const { data: existingMeal, error: fetchError } = await supabase
        .from('meal_logs')
        .select('*')
        .eq('id', mealId)
        .eq('user_id', userId)
        .single();
      
      if (fetchError || !existingMeal) {
        return res.status(404).json({
          success: false,
          error: 'Meal not found or unauthorized'
        });
      }
      
      // Update the meal
      const updateData = {};
      if (meal_name !== undefined) updateData.meal_name = meal_name;
      if (ingredients_logged !== undefined) updateData.ingredients_logged = ingredients_logged;
      
      const { data: updatedMeal, error: updateError } = await supabase
        .from('meal_logs')
        .update(updateData)
        .eq('id', mealId)
        .eq('user_id', userId)
        .select()
        .single();
      
      if (updateError) {
        throw updateError;
      }
      
      console.log(`✅ [${requestId}] Meal updated successfully`);
      console.log(`✅ ================== MEAL UPDATE END ==================\n`);
      
      res.json({
        success: true,
        meal: updatedMeal,
        requestId: requestId,
        timestamp: new Date().toISOString()
      });
      
    } catch (error) {
      console.error(`❌ [${requestId}] Meal update error:`, error);
      
      res.status(500).json({
        success: false,
        error: 'Failed to update meal',
        details: process.env.NODE_ENV === 'development' ? error.message : undefined,
        requestId: requestId,
        timestamp: new Date().toISOString()
      });
    }
  },

  /**
   * Delete a meal
   * @route DELETE /api/meals/:id
   */
  async deleteMeal(req, res) {
    const requestId = Math.random().toString(36).substring(7);
    
    try {
      console.log(`\n🗑️ ================== MEAL DELETE START ==================`);
      console.log(`🗑️ REQUEST ID: ${requestId}`);
      
      const userId = getUserIdFromToken(req);
      const mealId = req.params.id;
      
      console.log(`🗑️ [${requestId}] User ID: ${userId}`);
      console.log(`🗑️ [${requestId}] Meal ID: ${mealId}`);
      
      const supabase = getServiceClient();
      
      // First, let's debug by checking if the meal exists at all
      console.log(`🗑️ [${requestId}] Debug: First checking if meal exists...`);
      const { data: mealCheck, error: checkError } = await supabase
        .from('meal_logs')
        .select('id, user_id')
        .eq('id', mealId)
        .single();
      
      if (checkError || !mealCheck) {
        console.log(`🗑️ [${requestId}] Meal doesn't exist at all!`);
        return res.status(404).json({
          success: false,
          error: 'Meal not found'
        });
      }
      
      console.log(`🗑️ [${requestId}] Meal found! Comparing user IDs...`);
      console.log(`🗑️ [${requestId}] JWT userId: "${userId}" (type: ${typeof userId})`);
      console.log(`🗑️ [${requestId}] Meal user_id: "${mealCheck.user_id}" (type: ${typeof mealCheck.user_id})`);
      console.log(`🗑️ [${requestId}] IDs match: ${userId === mealCheck.user_id}`);
      console.log(`🗑️ [${requestId}] IDs match (string): ${String(userId) === String(mealCheck.user_id)}`);
      
      // Check if user owns this meal (with string comparison for safety)
      if (String(userId) !== String(mealCheck.user_id)) {
        console.log(`🗑️ [${requestId}] User doesn't own this meal!`);
        return res.status(403).json({
          success: false,
          error: 'Unauthorized to delete this meal'
        });
      }
      
      console.log(`🗑️ [${requestId}] User owns the meal, proceeding with deletion...`);
      
      // Delete the meal
      const { error: deleteError } = await supabase
        .from('meal_logs')
        .delete()
        .eq('id', mealId)
        .eq('user_id', userId);
      
      if (deleteError) {
        throw deleteError;
      }
      
      console.log(`✅ [${requestId}] Meal deleted successfully`);
      console.log(`✅ ================== MEAL DELETE END ==================\n`);
      
      res.json({
        success: true,
        message: 'Meal deleted successfully',
        requestId: requestId,
        timestamp: new Date().toISOString()
      });
      
    } catch (error) {
      console.error(`❌ [${requestId}] Meal delete error:`, error);
      
      res.status(500).json({
        success: false,
        error: 'Failed to delete meal',
        details: process.env.NODE_ENV === 'development' ? error.message : undefined,
        requestId: requestId,
        timestamp: new Date().toISOString()
      });
    }
  },

  /**
   * Log a dine-out meal (without ingredient deduction)
   */
  async logDineOutMeal(req, res) {
    const requestId = Math.random().toString(36).substring(7);

    try {
      console.log(`\n🍴 ================== DINE OUT MEAL LOG START ==================`);
      console.log(`🍴 REQUEST ID: ${requestId}`);

      // Get user ID from token
      const userId = getUserIdFromToken(req);
      console.log(`🍴 [${requestId}] User ID: ${userId}`);

      // Get meal type from form data or body
      // When using multer with FormData, non-file fields are still in req.body
      const mealType = req.body.mealType || req.body.meal_type;
      console.log(`🍴 [${requestId}] Request body:`, req.body);
      console.log(`🍴 [${requestId}] Meal type: ${mealType}`);

      // Validate meal type
      const validMealTypes = ['breakfast', 'lunch', 'dinner', 'snack'];
      if (!mealType || !validMealTypes.includes(mealType)) {
        throw new Error('Invalid meal type. Must be breakfast, lunch, dinner, or snack');
      }

      // Analyze the meal image for calorie estimation if image is provided
      let mealName = 'Dine Out Meal';
      let estimatedCalories = null;

      if (req.file) {
        try {
          console.log(`🍴 [${requestId}] Analyzing dine-out meal for calories...`);

          // Use the existing meal analysis service
          const analysisResult = await mealAnalysisService.analyzeMealImage(req.file.buffer);

          // Extract meal name and calculate total calories
          if (analysisResult) {
            mealName = analysisResult.meal_name || 'Dine Out Meal';

            // Calculate total calories from all detected ingredients
            const ingredients = analysisResult.ingredients || analysisResult;
            if (Array.isArray(ingredients)) {
              estimatedCalories = ingredients.reduce((total, item) => {
                return total + (item.calories || 0);
              }, 0);

              console.log(`🍴 [${requestId}] Meal name: ${mealName}`);
              console.log(`🍴 [${requestId}] Estimated calories: ${estimatedCalories}`);
            }
          }
        } catch (analysisError) {
          console.error(`🍴 [${requestId}] Error analyzing meal for calories:`, analysisError);
          // Continue without calorie estimation if analysis fails
        }
      }

      // Upload image to Supabase Storage if provided (retries once, non-fatal)
      let imageUrl = null;
      if (req.file) {
        imageUrl = await uploadMealPhoto(userId, req.file, requestId, 'dine-out_');
      }

      // Get current date or use provided target date
      const targetDate = req.body.targetDate ? new Date(req.body.targetDate) : new Date();

      // Save dine-out meal log to database
      const supabase = getServiceClient();
      const { data: mealLog, error: dbError } = await supabase
        .from('meal_logs')
        .insert({
          user_id: userId,
          meal_photo_url: imageUrl,
          meal_type: mealType,
          meal_name: mealName,  // Use the AI-detected meal name
          is_dine_out: true, // Mark as dine-out meal
          ingredients_detected: null, // No ingredients for dine-out
          ingredients_logged: estimatedCalories ? [{
            name: 'Total Calories',
            calories: estimatedCalories,
            quantity: 1,
            unit: 'meal'
          }] : null, // Store calories in ingredients_logged for consistency
          logged_at: targetDate.toISOString(),
          created_at: new Date().toISOString()
        })
        .select()
        .single();

      if (dbError) {
        console.error(`🍴 [${requestId}] Database error:`, dbError);
        console.error(`🍴 [${requestId}] Error details:`, JSON.stringify(dbError, null, 2));
        throw new Error(`Failed to save dine-out meal: ${dbError.message || 'Database error'}`);
      }

      console.log(`🍴 [${requestId}] Dine-out meal logged successfully:`, mealLog.id);

      res.json({
        success: true,
        message: 'Dine-out meal logged successfully',
        meal: mealLog,
        requestId: requestId,
        timestamp: new Date().toISOString()
      });

      // Streak: fire-and-forget; back-dated logs (targetDate ≠ today) don't count
      streakService.recordActionForDate(userId, 'meal_log', req.body.targetDate).catch(err => {
        console.error(`[Streak] Failed to record meal_log (dine-out):`, err.message);
      });

      console.log(`✅ [${requestId}] Dine-out meal log complete`);
      console.log(`✅ ================== DINE OUT MEAL LOG END ==================\n`);

    } catch (error) {
      console.error(`❌ [${requestId}] Dine-out meal log error:`, error);

      const statusCode = error.message.includes('token') ? 401 : 500;

      res.status(statusCode).json({
        success: false,
        error: error.message.includes('token') ? 'Authentication required' : error.message,
        requestId: requestId,
        timestamp: new Date().toISOString()
      });
    }
  },

  /**
   * Get calendar summary — lightweight daily meal counts for a year
   * GET /api/meals/calendar-summary?year=2026
   */
  async getCalendarSummary(req, res) {
    try {
      const userId = getUserIdFromToken(req);
      const year = parseInt(req.query.year) || new Date().getFullYear();

      const supabase = getServiceClient();

      // Fetch user's timezone
      const { data: userData } = await supabase
        .from('users')
        .select('timezone')
        .eq('id', userId)
        .single();

      const userTimezone = userData?.timezone || 'America/Los_Angeles';

      // Get UTC range for the full year in user's timezone
      const startOfYear = moment.tz(`${year}-01-01`, userTimezone).startOf('day').utc().toISOString();
      const endOfYear = moment.tz(`${year}-12-31`, userTimezone).endOf('day').utc().toISOString();

      // Fetch only the fields we need
      const { data: meals, error } = await supabase
        .from('meal_logs')
        .select('logged_at, is_dine_out')
        .eq('user_id', userId)
        .gte('logged_at', startOfYear)
        .lte('logged_at', endOfYear);

      if (error) throw error;

      // Aggregate by local date
      const summary = {};
      (meals || []).forEach(meal => {
        const localDate = moment.utc(meal.logged_at).tz(userTimezone).format('YYYY-MM-DD');
        if (!summary[localDate]) {
          summary[localDate] = { eat_in: 0, dine_out: 0 };
        }
        if (meal.is_dine_out) {
          summary[localDate].dine_out++;
        } else {
          summary[localDate].eat_in++;
        }
      });

      res.json({
        success: true,
        summary,
        year,
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      const statusCode = error.message.includes('token') ? 401 : 500;
      res.status(statusCode).json({
        success: false,
        error: error.message.includes('token') ? 'Authentication required' : 'Failed to get calendar summary',
        timestamp: new Date().toISOString()
      });
    }
  }
};

module.exports = mealController;