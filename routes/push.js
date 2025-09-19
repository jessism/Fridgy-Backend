const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middleware/auth');
const pushNotificationService = require('../services/pushNotificationService');

// Get VAPID public key
router.get('/vapid-public-key', (req, res) => {
  res.json({
    publicKey: process.env.VAPID_PUBLIC_KEY
  });
});

// Subscribe to push notifications
router.post('/subscribe', authenticateToken, async (req, res) => {
  try {
    const { subscription } = req.body;
    const userId = req.user.id;

    if (!subscription) {
      return res.status(400).json({
        success: false,
        message: 'Subscription data required'
      });
    }

    const result = await pushNotificationService.saveSubscription(userId, subscription);
    res.json(result);
  } catch (error) {
    console.error('Subscribe error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to save subscription'
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