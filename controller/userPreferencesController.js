const jwt = require('jsonwebtoken');
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

// User Preferences Controller Functions
const userPreferencesController = {
  
  /**
   * Get user's dietary preferences
   * GET /api/user-preferences
   */
  async getPreferences(req, res) {
    const requestId = Math.random().toString(36).substring(7);
    
    try {
      console.log(`\n🍽️  ================ GET USER PREFERENCES START ================`);
      console.log(`🍽️  REQUEST ID: ${requestId}`);
      
      // Get user ID from JWT token
      const userId = getUserIdFromToken(req);
      console.log(`🍽️  [${requestId}] User ID: ${userId}`);
      
      const supabase = getServiceClient();
      
      // Fetch user preferences
      const { data: preferences, error } = await supabase
        .from('user_dietary_preferences')
        .select('*')
        .eq('user_id', userId)
        .single();
      
      if (error && error.code !== 'PGRST116') { // PGRST116 = no rows returned
        console.error(`❌ [${requestId}] Supabase error:`, error);
        throw error;
      }
      
      console.log(`✅ [${requestId}] Preferences retrieved successfully`);
      
      // Return preferences or default empty values
      const defaultPreferences = {
        dietary_restrictions: [],
        allergies: [],
        custom_allergies: '',
        preferred_cuisines: [],
        cooking_time_preference: ''
      };
      
      const result = preferences || defaultPreferences;
      
      res.json({
        success: true,
        preferences: result,
        hasPreferences: !!preferences,
        requestId: requestId
      });
      
      console.log(`\n✅ [${requestId}] ============= GET USER PREFERENCES COMPLETE =============\n`);
      
    } catch (error) {
      console.error(`\n💥 [${requestId}] ========== GET USER PREFERENCES ERROR ==========`);
      console.error(`💥 [${requestId}] Error:`, error);
      console.error(`💥 [${requestId}] =============================================\n`);
      
      const statusCode = error.message.includes('token') ? 401 : 500;
      
      res.status(statusCode).json({
        success: false,
        error: error.message.includes('token') ? 'Authentication required' : 'Failed to fetch preferences',
        requestId: requestId
      });
    }
  },

  /**
   * Save or update user's dietary preferences
   * POST /api/user-preferences
   */
  async savePreferences(req, res) {
    const requestId = Math.random().toString(36).substring(7);
    
    try {
      console.log(`\n💾 ================ SAVE USER PREFERENCES START ================`);
      console.log(`💾 REQUEST ID: ${requestId}`);
      
      const {
        dietary_restrictions = [],
        allergies = [],
        custom_allergies = '',
        preferred_cuisines = [],
        cooking_time_preference = ''
      } = req.body;
      
      // Get user ID from JWT token
      const userId = getUserIdFromToken(req);
      console.log(`💾 [${requestId}] User ID: ${userId}`);
      
      // Validate input data
      if (!Array.isArray(dietary_restrictions) || !Array.isArray(allergies) || !Array.isArray(preferred_cuisines)) {
        throw new Error('Arrays expected for dietary_restrictions, allergies, and preferred_cuisines');
      }
      
      const validCookingTimes = ['under_15', '15_30', '30_60', 'over_60', ''];
      if (cooking_time_preference && !validCookingTimes.includes(cooking_time_preference)) {
        throw new Error('Invalid cooking time preference');
      }
      
      console.log(`💾 [${requestId}] Preferences to save:`, {
        dietary_restrictions: dietary_restrictions.length,
        allergies: allergies.length,
        preferred_cuisines: preferred_cuisines.length,
        cooking_time_preference
      });
      
      const supabase = getServiceClient();
      
      // Use upsert to insert or update
      const { data: savedPreferences, error } = await supabase
        .from('user_dietary_preferences')
        .upsert({
          user_id: userId,
          dietary_restrictions,
          allergies,
          custom_allergies: custom_allergies.trim(),
          preferred_cuisines,
          cooking_time_preference,
          updated_at: new Date().toISOString()
        }, {
          onConflict: 'user_id'
        })
        .select('*')
        .single();
      
      if (error) {
        console.error(`❌ [${requestId}] Supabase error:`, error);
        throw error;
      }
      
      console.log(`✅ [${requestId}] Preferences saved successfully`);
      
      res.json({
        success: true,
        message: 'Preferences saved successfully',
        preferences: savedPreferences,
        requestId: requestId
      });
      
      console.log(`\n✅ [${requestId}] ============= SAVE USER PREFERENCES COMPLETE =============\n`);
      
    } catch (error) {
      console.error(`\n💥 [${requestId}] ========== SAVE USER PREFERENCES ERROR ==========`);
      console.error(`💥 [${requestId}] Error:`, error);
      console.error(`💥 [${requestId}] =============================================\n`);
      
      const statusCode = error.message.includes('token') ? 401 :
                        error.message.includes('Arrays expected') || error.message.includes('Invalid') ? 400 : 500;
      
      res.status(statusCode).json({
        success: false,
        error: error.message.includes('token') ? 'Authentication required' : 
               error.message.includes('Arrays expected') || error.message.includes('Invalid') ? error.message :
               'Failed to save preferences',
        requestId: requestId
      });
    }
  },

  /**
   * Delete user's dietary preferences
   * DELETE /api/user-preferences
   */
  async deletePreferences(req, res) {
    const requestId = Math.random().toString(36).substring(7);
    
    try {
      console.log(`\n🗑️  ================ DELETE USER PREFERENCES START ================`);
      console.log(`🗑️  REQUEST ID: ${requestId}`);
      
      // Get user ID from JWT token
      const userId = getUserIdFromToken(req);
      console.log(`🗑️  [${requestId}] User ID: ${userId}`);
      
      const supabase = getServiceClient();
      
      // Delete user preferences
      const { error } = await supabase
        .from('user_dietary_preferences')
        .delete()
        .eq('user_id', userId);
      
      if (error) {
        console.error(`❌ [${requestId}] Supabase error:`, error);
        throw error;
      }
      
      console.log(`✅ [${requestId}] Preferences deleted successfully`);
      
      res.json({
        success: true,
        message: 'Preferences deleted successfully',
        requestId: requestId
      });
      
      console.log(`\n✅ [${requestId}] ============= DELETE USER PREFERENCES COMPLETE =============\n`);
      
    } catch (error) {
      console.error(`\n💥 [${requestId}] ========== DELETE USER PREFERENCES ERROR ==========`);
      console.error(`💥 [${requestId}] Error:`, error);
      console.error(`💥 [${requestId}] ======================================\n`);
      
      const statusCode = error.message.includes('token') ? 401 : 500;
      
      res.status(statusCode).json({
        success: false,
        error: error.message.includes('token') ? 'Authentication required' : 'Failed to delete preferences',
        requestId: requestId
      });
    }
  },

  /**
   * Health check endpoint for preferences service
   * GET /api/user-preferences/health
   */
  async healthCheck(req, res) {
    const requestId = Math.random().toString(36).substring(7);
    
    try {
      const hasSupabase = !!process.env.SUPABASE_URL && !!process.env.SUPABASE_SERVICE_KEY;
      
      res.json({
        success: true,
        service: 'User Preferences Service',
        status: hasSupabase ? 'ready' : 'configuration_required',
        supabaseConfigured: hasSupabase,
        requestId: requestId,
        timestamp: new Date().toISOString()
      });
      
    } catch (error) {
      res.status(500).json({
        success: false,
        service: 'User Preferences Service',
        status: 'error',
        error: error.message,
        requestId: requestId
      });
    }
  }
};

module.exports = userPreferencesController;