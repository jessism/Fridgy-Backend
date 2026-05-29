const mealAnalysisService = require('../services/mealAnalysisService');
const inventoryDeductionService = require('../services/inventoryDeductionService');
const jwt = require('jsonwebtoken');
const { createClient } = require('@supabase/supabase-js');
const moment = require('moment-timezone');

// JWT secret
const JWT_SECRET = process.env.JWT_SECRET || 'your-super-secret-jwt-key-change-in-production';

// Helper function to get Supabase client
const getSupabaseClient = () => {
  return createClient(
    process.env.SUPABASE_URL || 'your-supabase-url',
    process.env.SUPABASE_ANON_KEY || 'your-supabase-anon-key'
  );
};

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

const mealController = {
  /**
   * Scan and analyze a meal photo
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
      
      // Upload image to Supabase Storage
      let imageUrl = null;
      try {
        // Generate unique filename
        const timestamp = Date.now();
        const randomId = Math.random().toString(36).substring(7);
        const fileName = `${userId}/${timestamp}_${randomId}.jpg`;
        
        console.log(`🍽️ [${requestId}] Uploading image to Storage: ${fileName}`);
        
        // Upload to Supabase Storage
        const supabase = getSupabaseClient();
        const { data: uploadData, error: uploadError } = await supabase.storage
          .from('meal-photos')
          .upload(fileName, req.file.buffer, {
            contentType: req.file.mimetype || 'image/jpeg',
            upsert: false
          });
        
        if (uploadError) {
          console.error(`🍽️ [${requestId}] Storage upload error:`, uploadError);
          // Continue without image URL if upload fails
        } else {
          // Get public URL
          const { data: urlData } = supabase.storage
            .from('meal-photos')
            .getPublicUrl(fileName);
          
          imageUrl = urlData.publicUrl;
          console.log(`🍽️ [${requestId}] Image uploaded successfully`);
          console.log(`🍽️ [${requestId}] Image URL: ${imageUrl}`);
          console.log(`🍽️ [${requestId}] URL type: ${typeof imageUrl}`);
          console.log(`🍽️ [${requestId}] URL length: ${imageUrl ? imageUrl.length : 0}`);
        }
      } catch (storageError) {
        console.error(`🍽️ [${requestId}] Storage error:`, storageError);
        // Continue without image URL
      }
      
      // Analyze the meal image
      const analysisResult = await mealAnalysisService.analyzeMealImage(req.file.buffer);
      const detectedIngredients = analysisResult.ingredients || analysisResult;
      const mealName = analysisResult.meal_name || 'Home-cooked Meal';
      
      console.log(`🍽️ [${requestId}] Meal name: ${mealName}`);
      console.log(`🍽️ [${requestId}] Detected ${detectedIngredients.length} ingredients`);
      
      // Return the detected ingredients with image URL and meal name
      console.log(`🍽️ [${requestId}] Preparing response with imageUrl: ${imageUrl}`);
      
      res.json({
        success: true,
        meal_name: mealName,  // Include the meal name
        ingredients: detectedIngredients,
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
      
      const { ingredients, imageUrl, mealType, targetDate, mealName } = req.body;
      
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
      
      // Deduct ingredients from inventory and save meal log
      const deductionResult = await inventoryDeductionService.deductFromInventory(
        userId,
        ingredients,
        imageUrl,  // Pass image URL to save in meal log
        mealType,  // Pass meal type to save in meal log
        logDate,   // Pass target date to save in meal log
        mealName   // Pass meal name to save in meal log
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
      
      const supabase = createClient(
        process.env.SUPABASE_URL,
        process.env.SUPABASE_ANON_KEY
      );
      
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
      
      const supabase = getSupabaseClient();
      
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
      
      const supabase = getSupabaseClient();
      
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

      // Upload image to Supabase Storage if provided
      let imageUrl = null;
      if (req.file) {
        try {
          // Generate unique filename
          const timestamp = Date.now();
          const randomId = Math.random().toString(36).substring(7);
          const fileName = `${userId}/dine-out_${timestamp}_${randomId}.jpg`;

          console.log(`🍴 [${requestId}] Uploading dine-out image: ${fileName}`);

          // Upload to Supabase Storage
          const supabase = getSupabaseClient();
          const { data: uploadData, error: uploadError } = await supabase.storage
            .from('meal-photos')
            .upload(fileName, req.file.buffer, {
              contentType: req.file.mimetype || 'image/jpeg',
              upsert: false
            });

          if (uploadError) {
            console.error(`🍴 [${requestId}] Storage upload error:`, uploadError);
          } else {
            // Get public URL
            const { data: urlData } = supabase.storage
              .from('meal-photos')
              .getPublicUrl(fileName);

            imageUrl = urlData.publicUrl;
            console.log(`🍴 [${requestId}] Image uploaded successfully`);
          }
        } catch (storageError) {
          console.error(`🍴 [${requestId}] Storage error:`, storageError);
          // Continue without image URL
        }
      }

      // Get current date or use provided target date
      const targetDate = req.body.targetDate ? new Date(req.body.targetDate) : new Date();

      // Save dine-out meal log to database
      const supabase = getSupabaseClient();
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

      const supabase = getSupabaseClient();

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