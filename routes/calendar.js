/**
 * Calendar Sync Routes
 * Handles Google Calendar OAuth and sync operations
 */

const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middleware/auth');
const googleCalendarService = require('../services/googleCalendarService');
const { getServiceClient } = require('../config/supabase');
const supabase = getServiceClient();

// Frontend URL for OAuth redirects
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';

/**
 * GET /api/calendar/auth-url
 * Get Google OAuth authorization URL
 */
router.get('/auth-url', authenticateToken, async (req, res) => {
  try {
    if (!googleCalendarService.isConfigured()) {
      return res.status(503).json({
        error: 'Google Calendar integration not configured',
        message: 'Please configure GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET'
      });
    }

    // Encode userId in state for callback
    const stateData = { userId: req.user.id };
    const state = Buffer.from(JSON.stringify(stateData)).toString('base64');
    console.log('[Calendar] Creating auth URL with state:', { stateData, state });
    const authUrl = googleCalendarService.getAuthUrl(state);
    console.log('[Calendar] Generated auth URL:', authUrl);

    res.json({ url: authUrl });
  } catch (error) {
    console.error('[Calendar] Error getting auth URL:', error);
    res.status(500).json({ error: 'Failed to generate authorization URL' });
  }
});

/**
 * GET /api/calendar/callback
 * OAuth callback - exchange code for tokens
 */
router.get('/callback', async (req, res) => {
  try {
    const { code, state, error: oauthError } = req.query;
    console.log('[Calendar] Callback received:', { code: code ? 'present' : 'missing', state, oauthError });

    if (oauthError) {
      console.error('[Calendar] OAuth error:', oauthError);
      return res.redirect(`${FRONTEND_URL}/calendar-settings?calendar_error=access_denied`);
    }

    if (!code || !state) {
      console.error('[Calendar] Missing code or state:', { code: !!code, state: !!state });
      return res.redirect(`${FRONTEND_URL}/calendar-settings?calendar_error=missing_params`);
    }

    // Decode state to get userId
    let userId;
    try {
      const decoded = Buffer.from(state, 'base64').toString();
      console.log('[Calendar] Decoded state string:', decoded);
      const stateData = JSON.parse(decoded);
      console.log('[Calendar] Parsed state data:', stateData);
      userId = stateData.userId;
      console.log('[Calendar] Extracted userId:', userId);
    } catch (e) {
      console.error('[Calendar] Failed to decode state:', e);
      return res.redirect(`${FRONTEND_URL}/calendar-settings?calendar_error=invalid_state`);
    }

    if (!userId) {
      console.error('[Calendar] userId is null or undefined after decoding');
      return res.redirect(`${FRONTEND_URL}/calendar-settings?calendar_error=invalid_state`);
    }

    // Exchange code for tokens
    const tokens = await googleCalendarService.exchangeCodeForTokens(code);

    // Get user's email
    const email = await googleCalendarService.getUserEmail(tokens.access_token);

    // Store connection in database (upsert)
    const { error: dbError } = await supabase
      .from('user_calendar_connections')
      .upsert({
        user_id: userId,
        provider: 'google',
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        token_expiry: tokens.expiry_date ? new Date(tokens.expiry_date).toISOString() : null,
        connected_email: email,
        is_active: true,
        updated_at: new Date().toISOString()
      }, {
        onConflict: 'user_id,provider'
      });

    if (dbError) {
      console.error('[Calendar] Error storing connection:', dbError);
      return res.redirect(`${FRONTEND_URL}/calendar-settings?calendar_error=storage_failed`);
    }

    // Create default preferences if they don't exist
    await supabase
      .from('user_meal_time_preferences')
      .upsert({
        user_id: userId,
        updated_at: new Date().toISOString()
      }, {
        onConflict: 'user_id',
        ignoreDuplicates: true
      });

    // Redirect to calendar settings with success
    res.redirect(`${FRONTEND_URL}/calendar-settings?calendar_connected=true`);
  } catch (error) {
    console.error('[Calendar] Callback error:', error);
    res.redirect(`${FRONTEND_URL}/calendar-settings?calendar_error=connection_failed`);
  }
});

/**
 * GET /api/calendar/status
 * Check if calendar is connected
 */
router.get('/status', authenticateToken, async (req, res) => {
  try {
    const { data: connection, error } = await supabase
      .from('user_calendar_connections')
      .select('connected_email, is_active, created_at')
      .eq('user_id', req.user.id)
      .eq('provider', 'google')
      .eq('is_active', true)
      .single();

    if (error || !connection) {
      return res.json({ connected: false });
    }

    res.json({
      connected: true,
      email: connection.connected_email,
      connectedAt: connection.created_at
    });
  } catch (error) {
    console.error('[Calendar] Error checking status:', error);
    res.status(500).json({ error: 'Failed to check calendar status' });
  }
});

/**
 * POST /api/calendar/disconnect
 * Disconnect Google Calendar
 */
router.post('/disconnect', authenticateToken, async (req, res) => {
  try {
    // Deactivate connection (keep record for potential reconnection)
    const { error: dbError } = await supabase
      .from('user_calendar_connections')
      .update({
        is_active: false,
        updated_at: new Date().toISOString()
      })
      .eq('user_id', req.user.id)
      .eq('provider', 'google');

    if (dbError) {
      throw dbError;
    }

    // Clear calendar_event_id from user's meal plans
    await supabase
      .from('meal_plans')
      .update({
        calendar_event_id: null,
        synced_at: null
      })
      .eq('user_id', req.user.id);

    res.json({ success: true });
  } catch (error) {
    console.error('[Calendar] Error disconnecting:', error);
    res.status(500).json({ error: 'Failed to disconnect calendar' });
  }
});

/**
 * GET /api/calendar/preferences
 * Get user's meal time preferences
 */
router.get('/preferences', authenticateToken, async (req, res) => {
  try {
    let { data: preferences, error } = await supabase
      .from('user_meal_time_preferences')
      .select('*')
      .eq('user_id', req.user.id)
      .single();

    if (error || !preferences) {
      // Return defaults if no preferences exist
      preferences = {
        breakfast_time: '08:00',
        lunch_time: '12:00',
        dinner_time: '19:00',
        snack_time: '15:00',
        meal_duration_minutes: 30,
        auto_sync: false,
        timezone: 'America/Los_Angeles'
      };
    }

    res.json({ preferences });
  } catch (error) {
    console.error('[Calendar] Error getting preferences:', error);
    res.status(500).json({ error: 'Failed to get preferences' });
  }
});

/**
 * PUT /api/calendar/preferences
 * Update user's meal time preferences
 */
router.put('/preferences', authenticateToken, async (req, res) => {
  try {
    const {
      breakfast_time,
      lunch_time,
      dinner_time,
      snack_time,
      meal_duration_minutes,
      auto_sync,
      timezone
    } = req.body;

    const { data: preferences, error } = await supabase
      .from('user_meal_time_preferences')
      .upsert({
        user_id: req.user.id,
        breakfast_time: breakfast_time || '08:00',
        lunch_time: lunch_time || '12:00',
        dinner_time: dinner_time || '19:00',
        snack_time: snack_time || '15:00',
        meal_duration_minutes: meal_duration_minutes || 30,
        auto_sync: auto_sync ?? false,
        timezone: timezone || 'America/Los_Angeles',
        updated_at: new Date().toISOString()
      }, {
        onConflict: 'user_id'
      })
      .select()
      .single();

    if (error) {
      throw error;
    }

    res.json({ preferences });
  } catch (error) {
    console.error('[Calendar] Error updating preferences:', error);
    res.status(500).json({ error: 'Failed to update preferences' });
  }
});

/**
 * Helper: Get user's calendar connection and tokens
 */
async function getConnectionWithTokens(userId) {
  const { data: connection, error } = await supabase
    .from('user_calendar_connections')
    .select('*')
    .eq('user_id', userId)
    .eq('provider', 'google')
    .eq('is_active', true)
    .single();

  if (error || !connection) {
    return null;
  }

  // Check if token needs refresh
  const now = new Date();
  const expiry = new Date(connection.token_expiry);

  if (expiry <= now) {
    // Token expired, refresh it
    try {
      const newTokens = await googleCalendarService.refreshAccessToken(connection.refresh_token);

      // Update stored tokens
      await supabase
        .from('user_calendar_connections')
        .update({
          access_token: newTokens.access_token,
          token_expiry: newTokens.expiry_date ? new Date(newTokens.expiry_date).toISOString() : null,
          updated_at: new Date().toISOString()
        })
        .eq('id', connection.id);

      connection.access_token = newTokens.access_token;
    } catch (refreshError) {
      console.error('[Calendar] Token refresh failed:', refreshError);
      return null;
    }
  }

  return {
    access_token: connection.access_token,
    refresh_token: connection.refresh_token
  };
}

/**
 * POST /api/calendar/sync/:mealPlanId
 * Sync a single meal to calendar
 */
router.post('/sync/:mealPlanId', authenticateToken, async (req, res) => {
  try {
    const { mealPlanId } = req.params;

    // Get connection tokens
    const tokens = await getConnectionWithTokens(req.user.id);
    if (!tokens) {
      return res.status(400).json({ error: 'Calendar not connected' });
    }

    // Get meal plan
    const { data: mealPlan, error: mealError } = await supabase
      .from('meal_plans')
      .select('*')
      .eq('id', mealPlanId)
      .eq('user_id', req.user.id)
      .single();

    if (mealError || !mealPlan) {
      return res.status(404).json({ error: 'Meal plan not found' });
    }

    // Get preferences
    const { data: preferences } = await supabase
      .from('user_meal_time_preferences')
      .select('*')
      .eq('user_id', req.user.id)
      .single();

    let eventId = mealPlan.calendar_event_id;

    if (eventId) {
      // Update existing event
      await googleCalendarService.updateMealEvent(tokens, eventId, mealPlan, preferences);
    } else {
      // Create new event
      eventId = await googleCalendarService.createMealEvent(tokens, mealPlan, preferences);
    }

    // Update meal plan with event ID
    await supabase
      .from('meal_plans')
      .update({
        calendar_event_id: eventId,
        synced_at: new Date().toISOString()
      })
      .eq('id', mealPlanId);

    res.json({ success: true, eventId });
  } catch (error) {
    console.error('[Calendar] Sync error:', error);
    res.status(500).json({ error: 'Failed to sync meal to calendar' });
  }
});

/**
 * DELETE /api/calendar/sync/:mealPlanId
 * Remove a meal from calendar
 */
router.delete('/sync/:mealPlanId', authenticateToken, async (req, res) => {
  try {
    const { mealPlanId } = req.params;

    // Get meal plan to check for event ID
    const { data: mealPlan, error: mealError } = await supabase
      .from('meal_plans')
      .select('calendar_event_id')
      .eq('id', mealPlanId)
      .eq('user_id', req.user.id)
      .single();

    if (mealError || !mealPlan) {
      return res.status(404).json({ error: 'Meal plan not found' });
    }

    if (mealPlan.calendar_event_id) {
      // Get connection tokens
      const tokens = await getConnectionWithTokens(req.user.id);
      if (tokens) {
        // Delete from calendar
        await googleCalendarService.deleteMealEvent(tokens, mealPlan.calendar_event_id);
      }
    }

    // Clear event ID from meal plan
    await supabase
      .from('meal_plans')
      .update({
        calendar_event_id: null,
        synced_at: null
      })
      .eq('id', mealPlanId);

    res.json({ success: true });
  } catch (error) {
    console.error('[Calendar] Unsync error:', error);
    res.status(500).json({ error: 'Failed to remove meal from calendar' });
  }
});

/**
 * POST /api/calendar/sync-week
 * Sync all meals for a date range
 */
router.post('/sync-week', authenticateToken, async (req, res) => {
  try {
    const { startDate, endDate } = req.body;

    if (!startDate || !endDate) {
      return res.status(400).json({ error: 'startDate and endDate are required' });
    }

    // Get connection tokens
    const tokens = await getConnectionWithTokens(req.user.id);
    if (!tokens) {
      return res.status(400).json({ error: 'Calendar not connected' });
    }

    // Get all meal plans in date range
    const { data: mealPlans, error: mealError } = await supabase
      .from('meal_plans')
      .select('*')
      .eq('user_id', req.user.id)
      .gte('date', startDate)
      .lte('date', endDate);

    if (mealError) {
      throw mealError;
    }

    // Get preferences
    const { data: preferences } = await supabase
      .from('user_meal_time_preferences')
      .select('*')
      .eq('user_id', req.user.id)
      .single();

    const results = {
      synced: 0,
      updated: 0,
      failed: 0
    };

    // Sync each meal
    for (const mealPlan of mealPlans || []) {
      try {
        let eventId = mealPlan.calendar_event_id;

        if (eventId) {
          await googleCalendarService.updateMealEvent(tokens, eventId, mealPlan, preferences);
          results.updated++;
        } else {
          eventId = await googleCalendarService.createMealEvent(tokens, mealPlan, preferences);
          results.synced++;
        }

        // Update meal plan with event ID
        await supabase
          .from('meal_plans')
          .update({
            calendar_event_id: eventId,
            synced_at: new Date().toISOString()
          })
          .eq('id', mealPlan.id);
      } catch (syncError) {
        console.error(`[Calendar] Failed to sync meal ${mealPlan.id}:`, syncError);
        results.failed++;
      }
    }

    res.json({ success: true, results });
  } catch (error) {
    console.error('[Calendar] Sync week error:', error);
    res.status(500).json({ error: 'Failed to sync meals to calendar' });
  }
});

module.exports = router;
