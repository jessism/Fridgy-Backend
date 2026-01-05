/**
 * Instagram DM Webhook Routes
 * Handles webhook verification, incoming messages, and account linking
 * Based on messenger.js pattern for Facebook Messenger
 */

const express = require('express');
const router = express.Router();
const instagramDMBot = require('../services/instagramDMBot');
const authMiddleware = require('../middleware/auth');

/**
 * GET /api/instagram-dm/webhook
 * Webhook verification endpoint - Meta calls this when setting up webhook
 */
router.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  console.log('[InstagramDM] Webhook verification request received');
  console.log('[InstagramDM] Mode:', mode);

  const verifyToken = process.env.INSTAGRAM_VERIFY_TOKEN || process.env.MESSENGER_VERIFY_TOKEN;
  console.log('[InstagramDM] Token matches:', token === verifyToken);

  if (mode === 'subscribe' && token === verifyToken) {
    console.log('[InstagramDM] Webhook verified successfully');
    res.status(200).send(challenge);
  } else {
    console.log('[InstagramDM] Webhook verification failed');
    res.sendStatus(403);
  }
});

/**
 * POST /api/instagram-dm/webhook
 * Receive incoming messages and events from Instagram
 */
router.post('/webhook', async (req, res) => {
  const body = req.body;

  console.log('[InstagramDM] Webhook event received:', JSON.stringify(body).substring(0, 200));

  // Verify this is an Instagram subscription
  if (body.object !== 'instagram') {
    console.log('[InstagramDM] Not an Instagram event, ignoring. Object:', body.object);
    return res.sendStatus(404);
  }

  // Respond immediately with 200 OK
  // Meta times out after 20 seconds, so we process asynchronously
  res.status(200).send('EVENT_RECEIVED');

  // Process events asynchronously
  try {
    for (const entry of body.entry || []) {
      const webhookEvent = entry.messaging?.[0];

      if (webhookEvent) {
        console.log('[InstagramDM] Processing event for IGSID:', webhookEvent.sender?.id);
        await instagramDMBot.handleEvent(webhookEvent);
      }
    }
  } catch (error) {
    console.error('[InstagramDM] Error processing webhook:', error);
    // Don't throw - we already sent 200 response
  }
});

/**
 * GET /api/instagram-dm/link
 * Redirect to frontend linking page (called from Instagram DM button)
 */
router.get('/link', (req, res) => {
  const { igsid, token } = req.query;

  console.log('[InstagramDM] Link request received for IGSID:', igsid);

  if (!igsid || !token) {
    return res.status(400).json({
      success: false,
      error: 'Missing IGSID or token'
    });
  }

  // Redirect to frontend linking page
  const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
  res.redirect(`${frontendUrl}/link-instagram-dm?igsid=${igsid}&token=${token}`);
});

/**
 * POST /api/instagram-dm/link
 * Complete account linking (called from frontend after user logs in)
 */
router.post('/link', authMiddleware.authenticateToken, async (req, res) => {
  try {
    const { igsid, token } = req.body;
    const userId = req.user?.userId || req.user?.id;

    console.log('[InstagramDM] Link completion request for user:', userId, 'IGSID:', igsid);

    if (!igsid || !token) {
      return res.status(400).json({
        success: false,
        error: 'Missing IGSID or token'
      });
    }

    // Validate token
    const isValid = await instagramDMBot.validateLinkToken(igsid, token);

    if (!isValid) {
      console.log('[InstagramDM] Invalid or expired link token');
      return res.status(400).json({
        success: false,
        error: 'Invalid or expired link token. Please try again from Instagram.'
      });
    }

    // Complete linking
    const success = await instagramDMBot.completeLinking(igsid, token, userId);

    if (!success) {
      return res.status(500).json({
        success: false,
        error: 'Failed to complete linking'
      });
    }

    console.log('[InstagramDM] Account linked successfully');

    res.json({
      success: true,
      message: 'Instagram account linked successfully!'
    });

  } catch (error) {
    console.error('[InstagramDM] Link completion error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to link account'
    });
  }
});

/**
 * GET /api/instagram-dm/status
 * Get Instagram DM connection status for current user
 */
router.get('/status', authMiddleware.authenticateToken, async (req, res) => {
  try {
    const userId = req.user?.userId || req.user?.id;

    const connection = await instagramDMBot.getConnectionForUser(userId);

    res.json({
      success: true,
      connected: !!connection,
      connection: connection ? {
        linkedAt: connection.linked_at,
        lastMessageAt: connection.last_message_at,
        instagramUsername: connection.instagram_username
      } : null
    });

  } catch (error) {
    console.error('[InstagramDM] Status check error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to check Instagram DM status'
    });
  }
});

/**
 * DELETE /api/instagram-dm/disconnect
 * Disconnect Instagram DM from current user's account
 */
router.delete('/disconnect', authMiddleware.authenticateToken, async (req, res) => {
  try {
    const userId = req.user?.userId || req.user?.id;

    console.log('[InstagramDM] Disconnect request for user:', userId);

    const success = await instagramDMBot.disconnectUser(userId);

    if (!success) {
      return res.status(500).json({
        success: false,
        error: 'Failed to disconnect Instagram DM'
      });
    }

    res.json({
      success: true,
      message: 'Instagram DM disconnected successfully'
    });

  } catch (error) {
    console.error('[InstagramDM] Disconnect error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to disconnect Instagram DM'
    });
  }
});

module.exports = router;
