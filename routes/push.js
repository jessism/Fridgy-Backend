const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middleware/auth');
const pushNotificationService = require('../services/pushNotificationService');

// Get VAPID public key
router.get('/vapid-public-key', (req, res) => {
  const publicKey = process.env.VAPID_PUBLIC_KEY;
  console.log('VAPID public key requested, key exists:', !!publicKey);

  if (!publicKey) {
    console.error('VAPID_PUBLIC_KEY not found in environment variables!');
    return res.status(500).json({
      error: 'VAPID key not configured on server'
    });
  }

  res.json({
    publicKey: publicKey
  });
});

// Subscribe to push notifications
router.post('/subscribe', authenticateToken, async (req, res) => {
  try {
    console.log('Push subscription request from user:', req.user.id, req.user.email);
    const { subscription } = req.body;
    const userId = req.user.id;

    console.log('Subscription object received:', JSON.stringify(subscription, null, 2));

    if (!subscription) {
      console.error('No subscription data provided');
      return res.status(400).json({
        success: false,
        message: 'Subscription data required'
      });
    }

    console.log('Saving subscription for user:', userId);
    const result = await pushNotificationService.saveSubscription(userId, subscription);
    console.log('Subscription save result:', result);
    res.json(result);
  } catch (error) {
    console.error('Subscribe error:', error.message || error);
    console.error('Stack trace:', error.stack);
    res.status(500).json({
      success: false,
      message: `Failed to save subscription: ${error.message || 'Unknown error'}`
    });
  }
});

// Unsubscribe from push notifications
router.post('/unsubscribe', authenticateToken, async (req, res) => {
  try {
    const { endpoint } = req.body;
    const userId = req.user.id;

    if (!endpoint) {
      return res.status(400).json({
        success: false,
        message: 'Endpoint required'
      });
    }

    const result = await pushNotificationService.removeSubscription(userId, endpoint);
    res.json(result);
  } catch (error) {
    console.error('Unsubscribe error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to remove subscription'
    });
  }
});

// Send test notification
router.post('/test', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const results = await pushNotificationService.sendTestNotification(userId);

    const successful = results.filter(r => r.success).length;
    const failed = results.filter(r => !r.success).length;

    res.json({
      success: successful > 0,
      message: `Sent to ${successful} device(s), ${failed} failed`
    });
  } catch (error) {
    console.error('Test notification error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to send test notification'
    });
  }
});

// Get notification preferences
router.get('/preferences', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const preferences = await pushNotificationService.getUserPreferences(userId);
    res.json({ success: true, preferences });
  } catch (error) {
    console.error('Get preferences error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get preferences'
    });
  }
});

// Update notification preferences
router.put('/preferences', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const { enabled, days_before_expiry, notification_time, timezone } = req.body;

    const result = await pushNotificationService.updateUserPreferences(userId, {
      enabled,
      days_before_expiry,
      notification_time,
      timezone
    });

    res.json(result);
  } catch (error) {
    console.error('Update preferences error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update preferences'
    });
  }
});

// Check subscription status
router.post('/check-subscription', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const subscriptions = await pushNotificationService.getUserSubscriptions(userId);

    res.json({
      success: true,
      isSubscribed: subscriptions.length > 0,
      subscriptionCount: subscriptions.length
    });
  } catch (error) {
    console.error('Check subscription error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to check subscription status'
    });
  }
});

module.exports = router;