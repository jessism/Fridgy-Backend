const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middleware/auth');
const pushNotificationService = require('../services/pushNotificationService');
const testScheduler = require('../services/testNotificationScheduler');

// Get VAPID public key
router.get('/vapid-public-key', (req, res) => {
  const publicKey = process.env.VAPID_PUBLIC_KEY;

  console.log('[VAPID] Public key requested:', {
    origin: req.headers.origin,
    referer: req.headers.referer,
    userAgent: req.headers['user-agent'],
    keyExists: !!publicKey,
    keyLength: publicKey ? publicKey.length : 0
  });

  // Add CORS headers for production domains
  const allowedOrigins = [
    'http://localhost:3000',
    'http://192.168.1.72:3000',
    'https://trackabite.app',
    'https://www.trackabite.app'
  ];

  const origin = req.headers.origin;
  if (allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  }

  if (!publicKey) {
    console.error('[VAPID] ERROR: VAPID_PUBLIC_KEY not found in environment variables!');
    return res.status(500).json({
      error: 'VAPID key not configured on server'
    });
  }

  console.log('[VAPID] Sending public key successfully');
  res.json({
    publicKey: publicKey
  });
});

// Subscribe to push notifications
router.post('/subscribe', authenticateToken, async (req, res) => {
  try {
    console.log('=== PUSH SUBSCRIPTION REQUEST ===');
    console.log('User:', req.user ? `${req.user.id} (${req.user.email})` : 'NO USER');
    console.log('Origin:', req.headers.origin);
    console.log('Headers:', {
      authorization: req.headers.authorization ? 'Present' : 'Missing',
      contentType: req.headers['content-type'],
      origin: req.headers.origin
    });

    const { subscription } = req.body;
    const userId = req.user.id;

    console.log('Subscription object received:', subscription ? 'Yes' : 'No');
    if (subscription) {
      console.log('Subscription keys:', Object.keys(subscription));
      console.log('Endpoint:', subscription.endpoint ? subscription.endpoint.substring(0, 50) + '...' : 'Missing');
    }

    if (!subscription) {
      console.error('No subscription data provided');
      return res.status(400).json({
        success: false,
        message: 'Subscription data required',
        details: 'The subscription object was not provided in the request body'
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

// === MOBILE PUSH NOTIFICATIONS ===

// Register a mobile (Expo) push token
router.post('/mobile/register', authenticateToken, async (req, res) => {
  try {
    const { token, deviceName } = req.body;
    const userId = req.user.id;

    if (!token) {
      return res.status(400).json({ success: false, message: 'Push token is required' });
    }

    const result = await pushNotificationService.saveMobileToken(userId, token, deviceName);
    res.json(result);
  } catch (error) {
    console.error('[Push] Mobile register error:', error.message);
    res.status(500).json({ success: false, message: error.message || 'Failed to register mobile token' });
  }
});

// Unregister a mobile (Expo) push token
router.post('/mobile/unregister', authenticateToken, async (req, res) => {
  try {
    const { token } = req.body;
    const userId = req.user.id;

    if (!token) {
      return res.status(400).json({ success: false, message: 'Push token is required' });
    }

    const result = await pushNotificationService.removeMobileToken(userId, token);
    res.json(result);
  } catch (error) {
    console.error('[Push] Mobile unregister error:', error.message);
    res.status(500).json({ success: false, message: 'Failed to unregister mobile token' });
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

// Get daily reminder preferences
router.get('/daily-reminders', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const dailyReminders = await pushNotificationService.getUserDailyReminders(userId);
    res.json({ success: true, dailyReminders });
  } catch (error) {
    console.error('Error fetching daily reminders:', error);
    res.status(500).json({ error: 'Failed to fetch daily reminders' });
  }
});

// Update daily reminder preferences
router.put('/daily-reminders', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const { dailyReminders } = req.body;

    if (!dailyReminders) {
      return res.status(400).json({ error: 'Daily reminders configuration required' });
    }

    await pushNotificationService.updateDailyReminders(userId, dailyReminders);
    res.json({ success: true, message: 'Daily reminders updated successfully' });
  } catch (error) {
    console.error('Error updating daily reminders:', error);
    res.status(500).json({ error: 'Failed to update daily reminders' });
  }
});

// Test a specific daily reminder
router.post('/test-daily-reminder', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const { reminderType } = req.body;

    // Get current daily reminders config
    const dailyReminders = await pushNotificationService.getUserDailyReminders(userId);
    const config = dailyReminders[reminderType];

    if (!config) {
      return res.status(400).json({ error: 'Invalid reminder type' });
    }

    // Send the test reminder
    await pushNotificationService.sendDailyReminder(userId, reminderType, config);
    res.json({ success: true, message: `Test ${reminderType} reminder sent` });
  } catch (error) {
    console.error('Test daily reminder error:', error);
    res.status(500).json({ error: 'Failed to send test daily reminder' });
  }
});

// Start 5-minute test notifications
router.post('/test/start', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    console.log(`[Push Route] Starting 5-minute test for user ${userId}`);

    const result = await testScheduler.startTestNotifications(userId);
    res.json(result);
  } catch (error) {
    console.error('Error starting test notifications:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to start test notifications'
    });
  }
});

// Stop test notifications
router.post('/test/stop', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    console.log(`[Push Route] Stopping test for user ${userId}`);

    const stopped = testScheduler.stopTestNotifications(userId);

    res.json({
      success: true,
      message: stopped ? 'Test notifications stopped' : 'No active test found'
    });
  } catch (error) {
    console.error('Error stopping test notifications:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to stop test notifications'
    });
  }
});

// Check test status
router.get('/test/status', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const isRunning = testScheduler.isTestRunning(userId);
    const nextTime = isRunning ? testScheduler.getNextFiveMinuteMark() : null;

    res.json({
      success: true,
      isRunning,
      nextTime
    });
  } catch (error) {
    console.error('Error checking test status:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to check test status'
    });
  }
});

// Get email notification preferences
router.get('/email-preferences', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const preferences = await pushNotificationService.getEmailPreferences(userId);
    res.json({ success: true, preferences });
  } catch (error) {
    console.error('Get email preferences error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get email preferences'
    });
  }
});

// Update email notification preferences
router.put('/email-preferences', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const { email_daily_expiry, email_weekly_summary, email_tips_updates } = req.body;

    const result = await pushNotificationService.updateEmailPreferences(userId, {
      email_daily_expiry,
      email_weekly_summary,
      email_tips_updates
    });

    res.json(result);
  } catch (error) {
    console.error('Update email preferences error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update email preferences'
    });
  }
});

// Unsubscribe from all email notifications (for email unsubscribe links)
router.post('/email/unsubscribe', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;

    // Turn off all email notifications
    const result = await pushNotificationService.updateEmailPreferences(userId, {
      email_daily_expiry: false,
      email_weekly_summary: false,
      email_tips_updates: false
    });

    res.json({
      success: true,
      message: 'Unsubscribed from all email notifications',
      result
    });
  } catch (error) {
    console.error('Email unsubscribe error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to unsubscribe from emails'
    });
  }
});

module.exports = router;