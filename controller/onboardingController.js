const { createClient } = require('@supabase/supabase-js');
const jwt = require('jsonwebtoken');

// Helper function to get Supabase client
const getSupabaseClient = () => {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_ANON_KEY;
  
  if (!supabaseUrl || !supabaseKey) {
    throw new Error('Supabase configuration missing');
  }
  
  return createClient(supabaseUrl, supabaseKey);
};

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

// Onboarding Controller Functions
const onboardingController = {
  
  /**
   * Save onboarding progress
   * POST /api/onboarding/save-progress
   */
  async saveProgress(req, res) {
    try {
      console.log('🔄 Saving onboarding progress...');
      
      // For unauthenticated users, just return success
      // Progress is saved in localStorage on the frontend
      const { step, data } = req.body;
      
      // Optionally save to session storage or temporary table
      // For now, we'll just acknowledge receipt
      
      res.json({
        success: true,
        message: 'Progress saved',
        step,
        timestamp: new Date().toISOString()
      });
      
    } catch (error) {
      console.error('❌ Error saving progress:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to save progress'
      });
    }
  },
  
  /**
   * Get onboarding progress
   * GET /api/onboarding/progress
   */
  async getProgress(req, res) {
    try {
      // For unauthenticated users, return empty progress
      // Real progress is in localStorage
      
      res.json({
        success: true,
        progress: null,
        message: 'No server-side progress found'
      });
      
    } catch (error) {
      console.error('❌ Error fetching progress:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to fetch progress'
      });
    }
  },
  
  /**
   * Complete onboarding with user data
   * POST /api/onboarding/complete
   */
  async completeOnboarding(req, res) {
    try {
      console.log('🎯 Completing onboarding...');
      
      // Get user ID from JWT token
      const userId = getUserIdFromToken(req);
      console.log('User ID:', userId);
      
      const {
        primary_goal,
        household_size,
        weekly_budget,
        budget_currency,
        notification_preferences,
        onboarding_completed,
        onboarding_version
      } = req.body;
      
      const supabase = getSupabaseClient();
      
      // Check if onboarding data already exists
      const { data: existingData, error: checkError } = await supabase
        .from('user_onboarding_data')
        .select('id')
        .eq('user_id', userId)
        .single();
      
      let result;
      
      if (existingData && !checkError) {
        // Update existing onboarding data
        const { data: updatedData, error: updateError } = await supabase
          .from('user_onboarding_data')
          .update({
            primary_goal,
            household_size,
            weekly_budget,
            budget_currency,
            notification_preferences,
            onboarding_completed,
            onboarding_version,
            updated_at: new Date().toISOString()
          })
          .eq('user_id', userId)
          .select()
          .single();
        
        if (updateError) {
          throw updateError;
        }
        
        result = updatedData;
      } else {
        // Insert new onboarding data
        const { data: newData, error: insertError } = await supabase
          .from('user_onboarding_data')
          .insert({
            user_id: userId,
            primary_goal,
            household_size,
            weekly_budget,
            budget_currency,
            notification_preferences,
            onboarding_completed,
            onboarding_version
          })
          .select()
          .single();
        
        if (insertError) {
          throw insertError;
        }
        
        result = newData;
      }
      
      console.log('✅ Onboarding completed successfully');
      
      res.json({
        success: true,
        message: 'Onboarding completed successfully',
        data: result
      });
      
    } catch (error) {
      console.error('❌ Error completing onboarding:', error);
      
      const statusCode = error.message?.includes('token') ? 401 : 500;
      
      res.status(statusCode).json({
        success: false,
        error: error.message?.includes('token') 
          ? 'Authentication required' 
          : 'Failed to complete onboarding'
      });
    }
  },
  
  /**
   * Skip onboarding
   * POST /api/onboarding/skip
   */
  async skipOnboarding(req, res) {
    try {
      console.log('⏭️ Skipping onboarding...');
      
      // Get user ID from JWT token (if available)
      let userId = null;
      try {
        userId = getUserIdFromToken(req);
      } catch (error) {
        // User not authenticated yet, that's okay for skip
        console.log('Skipping without authentication');
      }
      
      if (userId) {
        const supabase = getSupabaseClient();
        
        // Save minimal onboarding data
        await supabase
          .from('user_onboarding_data')
          .insert({
            user_id: userId,
            onboarding_completed: false,
            onboarding_version: '1.0',
            primary_goal: 'skipped'
          });
      }
      
      res.json({
        success: true,
        message: 'Onboarding skipped'
      });
      
    } catch (error) {
      console.error('❌ Error skipping onboarding:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to skip onboarding'
      });
    }
  }
};

module.exports = onboardingController;