/**
 * Google Drive Routes
 * Handles OAuth, connection management, and recipe sync to Google Drive
 */

const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middleware/auth');
const googleDriveService = require('../services/googleDriveService');
const pdfGeneratorService = require('../services/pdfGeneratorService');
const { getServiceClient } = require('../config/supabase');
const supabase = getServiceClient();

const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';
const FOLDER_NAME = 'Trackabite Recipes';

/**
 * GET /api/drive/auth-url
 * Get Google OAuth authorization URL
 */
router.get('/auth-url', authenticateToken, async (req, res) => {
  try {
    if (!googleDriveService.isConfigured()) {
      return res.status(503).json({
        error: 'Google Drive integration not configured',
        message: 'Please configure GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET'
      });
    }

    // Encode userId in state for callback
    const stateData = { userId: req.user.id };
    const state = Buffer.from(JSON.stringify(stateData)).toString('base64');
    console.log('[Drive] Creating auth URL with state:', { userId: req.user.id });

    const authUrl = googleDriveService.getAuthUrl(state);
    console.log('[Drive] Generated auth URL');

    res.json({ url: authUrl });
  } catch (error) {
    console.error('[Drive] Error getting auth URL:', error);
    res.status(500).json({ error: 'Failed to generate authorization URL' });
  }
});

/**
 * GET /api/drive/callback
 * OAuth callback - exchange code for tokens
 */
router.get('/callback', async (req, res) => {
  try {
    const { code, state, error: oauthError } = req.query;
    console.log('[Drive] Callback received:', { code: code ? 'present' : 'missing', state, oauthError });

    if (oauthError) {
      console.error('[Drive] OAuth error:', oauthError);
      return res.redirect(`${FRONTEND_URL}/drive-settings?drive_error=access_denied`);
    }

    if (!code || !state) {
      console.error('[Drive] Missing code or state');
      return res.redirect(`${FRONTEND_URL}/drive-settings?drive_error=missing_params`);
    }

    // Decode state to get userId
    let userId;
    try {
      const decoded = Buffer.from(state, 'base64').toString();
      const stateData = JSON.parse(decoded);
      userId = stateData.userId;
      console.log('[Drive] Extracted userId:', userId);
    } catch (e) {
      console.error('[Drive] Failed to decode state:', e);
      return res.redirect(`${FRONTEND_URL}/drive-settings?drive_error=invalid_state`);
    }

    if (!userId) {
      console.error('[Drive] userId is null or undefined');
      return res.redirect(`${FRONTEND_URL}/drive-settings?drive_error=invalid_state`);
    }

    // Exchange code for tokens
    console.log('[Drive] Exchanging code for tokens...');
    const tokens = await googleDriveService.exchangeCodeForTokens(code);

    // Get user's email
    const email = await googleDriveService.getUserEmail(tokens.access_token);
    console.log('[Drive] Connected email:', email);

    // Create Trackabite Recipes folder
    console.log('[Drive] Creating/finding Trackabite Recipes folder...');
    const folderId = await googleDriveService.createFolder(
      { access_token: tokens.access_token, refresh_token: tokens.refresh_token },
      FOLDER_NAME
    );
    console.log('[Drive] Folder ID:', folderId);

    // Store connection in database (upsert)
    const { error: dbError } = await supabase
      .from('user_drive_connections')
      .upsert({
        user_id: userId,
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        token_expiry: tokens.expiry_date ? new Date(tokens.expiry_date).toISOString() : null,
        connected_email: email,
        folder_id: folderId,
        is_active: true,
        auto_sync_enabled: false,  // Manual by default
        updated_at: new Date().toISOString()
      }, {
        onConflict: 'user_id'
      });

    if (dbError) {
      console.error('[Drive] Error storing connection:', dbError);
      return res.redirect(`${FRONTEND_URL}/drive-settings?drive_error=storage_failed`);
    }

    console.log('[Drive] Connection stored successfully');
    res.redirect(`${FRONTEND_URL}/drive-settings?drive_connected=true`);
  } catch (error) {
    console.error('[Drive] Callback error:', error);
    res.redirect(`${FRONTEND_URL}/drive-settings?drive_error=connection_failed`);
  }
});

/**
 * GET /api/drive/status
 * Check if Google Drive is connected
 */
router.get('/status', authenticateToken, async (req, res) => {
  try {
    const { data: connection, error } = await supabase
      .from('user_drive_connections')
      .select('connected_email, auto_sync_enabled, is_active, created_at')
      .eq('user_id', req.user.id)
      .eq('is_active', true)
      .single();

    if (error || !connection) {
      return res.json({ connected: false });
    }

    res.json({
      connected: true,
      email: connection.connected_email,
      autoSync: connection.auto_sync_enabled,
      connectedAt: connection.created_at
    });
  } catch (error) {
    console.error('[Drive] Error checking status:', error);
    res.status(500).json({ error: 'Failed to check Drive status' });
  }
});

/**
 * POST /api/drive/disconnect
 * Disconnect Google Drive
 */
router.post('/disconnect', authenticateToken, async (req, res) => {
  try {
    const { error: dbError } = await supabase
      .from('user_drive_connections')
      .delete()
      .eq('user_id', req.user.id);

    if (dbError) {
      throw dbError;
    }

    // Clear Drive sync status from all recipes (optional - keep file IDs for reference)
    await supabase
      .from('saved_recipes')
      .update({
        drive_sync_status: null
      })
      .eq('user_id', req.user.id);

    console.log('[Drive] Disconnected for user:', req.user.id);
    res.json({ success: true });
  } catch (error) {
    console.error('[Drive] Error disconnecting:', error);
    res.status(500).json({ error: 'Failed to disconnect Drive' });
  }
});

/**
 * PUT /api/drive/settings
 * Update Drive sync settings (e.g., auto-sync toggle)
 */
router.put('/settings', authenticateToken, async (req, res) => {
  try {
    const { autoSync } = req.body;

    const { data, error } = await supabase
      .from('user_drive_connections')
      .update({
        auto_sync_enabled: autoSync,
        updated_at: new Date().toISOString()
      })
      .eq('user_id', req.user.id)
      .eq('is_active', true)
      .select()
      .single();

    if (error) {
      throw error;
    }

    console.log('[Drive] Settings updated:', { autoSync });
    res.json({ success: true, autoSync: data.auto_sync_enabled });
  } catch (error) {
    console.error('[Drive] Error updating settings:', error);
    res.status(500).json({ error: 'Failed to update settings' });
  }
});

/**
 * Helper: Get connection with token refresh if needed
 */
async function getConnectionWithTokens(userId) {
  const { data: connection, error } = await supabase
    .from('user_drive_connections')
    .select('*')
    .eq('user_id', userId)
    .eq('is_active', true)
    .single();

  if (error || !connection) {
    return null;
  }

  // Check if token needs refresh
  const now = new Date();
  const expiry = connection.token_expiry ? new Date(connection.token_expiry) : now;

  if (expiry <= now) {
    console.log('[Drive] Token expired, refreshing...');
    try {
      const newTokens = await googleDriveService.refreshAccessToken(connection.refresh_token);

      // Update stored tokens
      await supabase
        .from('user_drive_connections')
        .update({
          access_token: newTokens.access_token,
          token_expiry: newTokens.expiry_date ? new Date(newTokens.expiry_date).toISOString() : null,
          updated_at: new Date().toISOString()
        })
        .eq('id', connection.id);

      connection.access_token = newTokens.access_token;
      console.log('[Drive] Token refreshed successfully');
    } catch (refreshError) {
      console.error('[Drive] Token refresh failed:', refreshError);
      return null;
    }
  }

  return {
    tokens: {
      access_token: connection.access_token,
      refresh_token: connection.refresh_token
    },
    folder_id: connection.folder_id
  };
}

/**
 * POST /api/drive/sync/:recipeId
 * Sync a single recipe to Google Drive
 */
router.post('/sync/:recipeId', authenticateToken, async (req, res) => {
  try {
    const { recipeId } = req.params;
    console.log(`[Drive] Syncing recipe ${recipeId}...`);

    // Get connection tokens
    const connection = await getConnectionWithTokens(req.user.id);
    if (!connection) {
      return res.status(400).json({ error: 'Google Drive not connected' });
    }

    // Get recipe
    const { data: recipe, error: recipeError } = await supabase
      .from('saved_recipes')
      .select('*')
      .eq('id', recipeId)
      .eq('user_id', req.user.id)
      .single();

    if (recipeError || !recipe) {
      return res.status(404).json({ error: 'Recipe not found' });
    }

    // Update status to pending
    await supabase
      .from('saved_recipes')
      .update({ drive_sync_status: 'pending' })
      .eq('id', recipeId);

    // Generate PDF
    console.log('[Drive] Generating PDF...');
    const pdfBuffer = await pdfGeneratorService.generateRecipePDF(recipe);

    // Create safe filename
    const fileName = `${(recipe.title || 'Recipe').replace(/[/\\?%*:|"<>]/g, '-')}.pdf`;

    // Upload to Drive
    console.log('[Drive] Uploading to Drive...');
    const fileId = await googleDriveService.uploadFile(
      connection.tokens,
      connection.folder_id,
      fileName,
      pdfBuffer,
      recipe.drive_file_id  // Pass existing ID for update
    );

    // Update recipe with Drive file ID and status
    await supabase
      .from('saved_recipes')
      .update({
        drive_file_id: fileId,
        drive_synced_at: new Date().toISOString(),
        drive_sync_status: 'synced'
      })
      .eq('id', recipeId);

    console.log(`[Drive] Recipe synced successfully: ${fileId}`);
    res.json({ success: true, fileId });
  } catch (error) {
    console.error('[Drive] Sync error:', error);

    // Mark as failed
    await supabase
      .from('saved_recipes')
      .update({ drive_sync_status: 'failed' })
      .eq('id', req.params.recipeId)
      .eq('user_id', req.user.id);

    res.status(500).json({ error: 'Failed to sync recipe to Drive' });
  }
});

/**
 * POST /api/drive/sync-all
 * Sync all recipes to Google Drive
 */
router.post('/sync-all', authenticateToken, async (req, res) => {
  try {
    console.log('[Drive] Starting sync-all for user:', req.user.id);

    // Get connection tokens
    const connection = await getConnectionWithTokens(req.user.id);
    if (!connection) {
      return res.status(400).json({ error: 'Google Drive not connected' });
    }

    // Get all recipes (including already synced ones for update)
    const { data: recipes, error: recipesError } = await supabase
      .from('saved_recipes')
      .select('*')
      .eq('user_id', req.user.id)
      .order('created_at', { ascending: false });

    if (recipesError) {
      throw recipesError;
    }

    if (!recipes || recipes.length === 0) {
      return res.json({ success: true, results: { synced: 0, failed: 0, total: 0 } });
    }

    console.log(`[Drive] Syncing ${recipes.length} recipes...`);

    const results = {
      synced: 0,
      failed: 0,
      total: recipes.length
    };

    // Process recipes sequentially to avoid rate limiting
    for (const recipe of recipes) {
      try {
        // Mark as pending
        await supabase
          .from('saved_recipes')
          .update({ drive_sync_status: 'pending' })
          .eq('id', recipe.id);

        // Generate PDF
        const pdfBuffer = await pdfGeneratorService.generateRecipePDF(recipe);

        // Create safe filename
        const fileName = `${(recipe.title || 'Recipe').replace(/[/\\?%*:|"<>]/g, '-')}.pdf`;

        // Upload to Drive
        const fileId = await googleDriveService.uploadFile(
          connection.tokens,
          connection.folder_id,
          fileName,
          pdfBuffer,
          recipe.drive_file_id
        );

        // Update recipe
        await supabase
          .from('saved_recipes')
          .update({
            drive_file_id: fileId,
            drive_synced_at: new Date().toISOString(),
            drive_sync_status: 'synced'
          })
          .eq('id', recipe.id);

        results.synced++;
        console.log(`[Drive] Synced: ${recipe.title} (${results.synced}/${results.total})`);

      } catch (syncError) {
        console.error(`[Drive] Failed to sync recipe ${recipe.id}:`, syncError.message);

        await supabase
          .from('saved_recipes')
          .update({ drive_sync_status: 'failed' })
          .eq('id', recipe.id);

        results.failed++;
      }

      // Small delay to avoid rate limiting
      await new Promise(resolve => setTimeout(resolve, 500));
    }

    console.log(`[Drive] Sync-all complete:`, results);
    res.json({ success: true, results });
  } catch (error) {
    console.error('[Drive] Sync-all error:', error);
    res.status(500).json({ error: 'Failed to sync recipes' });
  }
});

/**
 * GET /api/drive/sync-stats
 * Get sync statistics for user's recipes
 */
router.get('/sync-stats', authenticateToken, async (req, res) => {
  try {
    const { data: recipes, error } = await supabase
      .from('saved_recipes')
      .select('id, drive_sync_status')
      .eq('user_id', req.user.id);

    if (error) {
      throw error;
    }

    const stats = {
      total: recipes.length,
      synced: recipes.filter(r => r.drive_sync_status === 'synced').length,
      pending: recipes.filter(r => r.drive_sync_status === 'pending').length,
      failed: recipes.filter(r => r.drive_sync_status === 'failed').length,
      unsynced: recipes.filter(r => !r.drive_sync_status).length
    };

    res.json(stats);
  } catch (error) {
    console.error('[Drive] Error getting sync stats:', error);
    res.status(500).json({ error: 'Failed to get sync stats' });
  }
});

module.exports = router;
