/**
 * Facebook Messenger Webhook Routes
 * Handles webhook verification, incoming messages, and account linking
 */

const express = require('express');
const router = express.Router();
const messengerBot = require('../services/messengerBot');
const authMiddleware = require('../middleware/auth');

/**
 * GET /api/messenger/webhook
 * Webhook verification endpoint - Facebook calls this when setting up webhook
 */
router.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  console.log('[Messenger] Webhook verification request received');
  console.log('[Messenger] Mode:', mode);
  console.log('[Messenger] Token matches:', token === process.env.MESSENGER_VERIFY_TOKEN);

  if (mode === 'subscribe' && token === process.env.MESSENGER_VERIFY_TOKEN) {
    console.log('[Messenger] Webhook verified successfully');
    res.status(200).send(challenge);
  } else {
    console.log('[Messenger] Webhook verification failed');
    res.sendStatus(403);
  }
});

/**
 * POST /api/messenger/webhook
 * Receive incoming messages and events from Facebook
 */
router.post('/webhook', async (req, res) => {
  const body = req.body;

  console.log('[Messenger] Webhook event received:', JSON.stringify(body).substring(0, 200));

  // Verify this is a page subscription
  if (body.object !== 'page') {
    console.log('[Messenger] Not a page event, ignoring');
    return res.sendStatus(404);
  }

  // Respond immediately with 200 OK
  // Facebook times out after 20 seconds, so we process asynchronously
  res.status(200).send('EVENT_RECEIVED');

  // Process events asynchronously
  try {
    for (const entry of body.entry || []) {
      const webhookEvent = entry.messaging?.[0];

      if (webhookEvent) {
        console.log('[Messenger] Processing event for PSID:', webhookEvent.sender?.id);
        await messengerBot.handleEvent(webhookEvent);
      }
    }
  } catch (error) {
    console.error('[Messenger] Error processing webhook:', error);
    // Don't throw - we already sent 200 response
  }
});

/**
 * GET /api/messenger/link
 * Redirect to frontend linking page (called from Messenger button)
 */
router.get('/link', (req, res) => {
  const { psid, token } = req.query;

  console.log('[Messenger] Link request received for PSID:', psid);

  if (!psid || !token) {
    return res.status(400).json({
      success: false,
      error: 'Missing PSID or token'
    });
  }

  // Redirect to frontend linking page
  const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
  res.redirect(`${frontendUrl}/link-messenger?psid=${psid}&token=${token}`);
});

/**
 * POST /api/messenger/link
 * Complete account linking (called from frontend after user logs in)
 */
router.post('/link', authMiddleware.authenticateToken, async (req, res) => {
  try {
    const { psid, token } = req.body;
    const userId = req.user?.userId || req.user?.id;

    console.log('[Messenger] Link completion request for user:', userId, 'PSID:', psid);

    if (!psid || !token) {
      return res.status(400).json({
        success: false,
        error: 'Missing PSID or token'
      });
    }

    // Validate token
    const isValid = await messengerBot.validateLinkToken(psid, token);

    if (!isValid) {
      console.log('[Messenger] Invalid or expired link token');
      return res.status(400).json({
        success: false,
        error: 'Invalid or expired link token. Please try again from Messenger.'
      });
    }

    // Complete linking
    const success = await messengerBot.completeLinking(psid, token, userId);

    if (!success) {
      return res.status(500).json({
        success: false,
        error: 'Failed to complete linking'
      });
    }

    console.log('[Messenger] Account linked successfully');

    res.json({
      success: true,
      message: 'Messenger account linked successfully!'
    });

  } catch (error) {
    console.error('[Messenger] Link completion error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to link account'
    });
  }
});

/**
 * GET /api/messenger/status
 * Get messenger connection status for current user
 */
router.get('/status', authMiddleware.authenticateToken, async (req, res) => {
  try {
    const userId = req.user?.userId || req.user?.id;

    const connection = await messengerBot.getConnectionForUser(userId);

    res.json({
      success: true,
      connected: !!connection,
      connection: connection ? {
        linkedAt: connection.linked_at,
        lastMessageAt: connection.last_message_at
      } : null
    });

  } catch (error) {
    console.error('[Messenger] Status check error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to check messenger status'
    });
  }
});

/**
 * DELETE /api/messenger/disconnect
 * Disconnect messenger from current user's account
 */
router.delete('/disconnect', authMiddleware.authenticateToken, async (req, res) => {
  try {
    const userId = req.user?.userId || req.user?.id;

    console.log('[Messenger] Disconnect request for user:', userId);

    const success = await messengerBot.disconnectUser(userId);

    if (!success) {
      return res.status(500).json({
        success: false,
        error: 'Failed to disconnect messenger'
      });
    }

    res.json({
      success: true,
      message: 'Messenger disconnected successfully'
    });

  } catch (error) {
    console.error('[Messenger] Disconnect error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to disconnect messenger'
    });
  }
});

module.exports = router;
