const cron = require('node-cron');
const moment = require('moment-timezone');
const { createClient } = require('@supabase/supabase-js');
const pushNotificationService = require('./pushNotificationService');

// Initialize Supabase
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY
);

class ExpiryNotificationScheduler {
  constructor() {
    this.isRunning = false;
    this.scheduledTask = null;
  }

  // Start the scheduler
  start() {
    if (this.isRunning) {
      console.log('Expiry notification scheduler is already running');
      return;
    }

    // Schedule to run every day at 9 AM (server time)
    // You can adjust this to run more frequently for testing
    this.scheduledTask = cron.schedule('0 9 * * *', async () => {
      console.log('Running expiry notification check...');
      await this.checkAndSendExpiryNotifications();
    });

    // Also run every 6 hours for users in different timezones
    this.timezoneTask = cron.schedule('0 */6 * * *', async () => {
      console.log('Running timezone-aware expiry notification check...');
      await this.checkAndSendTimezoneAwareNotifications();
    });

    this.isRunning = true;
    console.log('Expiry notification scheduler started');

    // Run once on startup for testing (optional)
    if (process.env.NODE_ENV === 'development') {
      setTimeout(() => {
        console.log('Running initial expiry check (development mode)...');
        this.checkAndSendExpiryNotifications();
      }, 5000); // Wait 5 seconds after server start
    }
  }

  // Stop the scheduler
  stop() {
    if (this.scheduledTask) {
      this.scheduledTask.stop();
      this.scheduledTask = null;
    }
    if (this.timezoneTask) {
      this.timezoneTask.stop();
      this.timezoneTask = null;
    }
    this.isRunning = false;
    console.log('Expiry notification scheduler stopped');
  }

  // Check for expiring items and send notifications
  async checkAndSendExpiryNotifications() {
    try {
      // Get all users with notification preferences enabled
      const { data: preferences, error: prefError } = await supabase
        .from('notification_preferences')
        .select('user_id, days_before_expiry, enabled')
        .eq('enabled', true);

      if (prefError) {
        console.error('Error fetching notification preferences:', prefError);
        return;
      }

      // If no preferences exist, check all users with default settings
      let usersToNotify = preferences || [];

      if (usersToNotify.length === 0) {
        // Get all users who have items in their inventory
        const { data: users, error: usersError } = await supabase
          .from('fridge_items')
          .select('user_id')
          .is('deleted_at', null)
          .not('user_id', 'is', null);

        if (!usersError && users) {
          // Get unique user IDs
          const uniqueUserIds = [...new Set(users.map(u => u.user_id))];
          usersToNotify = uniqueUserIds.map(userId => ({
            user_id: userId,
            days_before_expiry: [1, 3], // Default days
            enabled: true
          }));
        }
      }

      console.log(`Checking expiry notifications for ${usersToNotify.length} users`);

      // Process each user
      for (const pref of usersToNotify) {
        await this.processUserExpiryNotifications(pref.user_id, pref.days_before_expiry || [1, 3]);
      }
    } catch (error) {
      console.error('Error in checkAndSendExpiryNotifications:', error);
    }
  }

  // Process notifications for a single user
  async processUserExpiryNotifications(userId, daysBeforeExpiry) {
    try {
      const today = new Date();
      today.setHours(0, 0, 0, 0);

      // Check each expiry window
      for (const days of daysBeforeExpiry) {
        const targetDate = new Date(today);
        targetDate.setDate(targetDate.getDate() + days);

        // Get items expiring on the target date
        const { data: items, error } = await supabase
          .from('fridge_items')
          .select('id, item_name, expiration_date, quantity')
          .eq('user_id', userId)
          .is('deleted_at', null)
          .gte('expiration_date', targetDate.toISOString().split('T')[0])
          .lte('expiration_date', targetDate.toISOString().split('T')[0] + 'T23:59:59');

        if (error) {
          console.error(`Error fetching items for user ${userId}:`, error);
          continue;
        }

        if (items && items.length > 0) {
          // Check if we've already sent a notification for these items today
          const notificationKey = `${userId}-${days}-${today.toISOString().split('T')[0]}`;
          const alreadySent = await this.hasNotificationBeenSent(userId, items, 'expiry', 24);

          if (!alreadySent) {
            // Send notification
            const results = await pushNotificationService.sendExpiryNotification(userId, items);

            // Log the notification
            await this.logNotification(userId, items, 'expiry', results);

            console.log(`Sent expiry notification to user ${userId} for ${items.length} items expiring in ${days} day(s)`);
          }
        }
      }

      // Also check for already expired items (once per day)
      const { data: expiredItems, error: expiredError } = await supabase
        .from('fridge_items')
        .select('id, item_name, expiration_date, quantity')
        .eq('user_id', userId)
        .is('deleted_at', null)
        .lt('expiration_date', today.toISOString().split('T')[0]);

      if (!expiredError && expiredItems && expiredItems.length > 0) {
        const alreadySent = await this.hasNotificationBeenSent(userId, expiredItems, 'expired', 24);

        if (!alreadySent) {
          // Send expired notification with different wording
          const payload = {
            title: '⚠️ Expired Food Alert',
            body: `You have ${expiredItems.length} expired item(s) in your inventory!`,
            icon: '/logo192.png',
            badge: '/logo192.png',
            tag: 'expired-notification',
            data: {
              url: '/inventory',
              items: expiredItems.map(i => ({
                name: i.item_name,
                expiryDate: i.expiration_date
              }))
            },
            requireInteraction: true
          };

          const results = await pushNotificationService.sendToUser(userId, payload);
          await this.logNotification(userId, expiredItems, 'expired', results);

          console.log(`Sent expired items notification to user ${userId} for ${expiredItems.length} items`);
        }
      }
    } catch (error) {
      console.error(`Error processing notifications for user ${userId}:`, error);
    }
  }

  // Check if a notification has been sent recently
  async hasNotificationBeenSent(userId, items, type, hoursThreshold) {
    try {
      const since = new Date();
      since.setHours(since.getHours() - hoursThreshold);

      const itemIds = items.map(i => i.id);

      const { data, error } = await supabase
        .from('notification_logs')
        .select('id')
        .eq('user_id', userId)
        .eq('notification_type', type)
        .in('item_id', itemIds)
        .gte('sent_at', since.toISOString())
        .limit(1);

      if (error) {
        console.error('Error checking notification logs:', error);
        return false;
      }

      return data && data.length > 0;
    } catch (error) {
      console.error('Error in hasNotificationBeenSent:', error);
      return false;
    }
  }

  // Log notification to database
  async logNotification(userId, items, type, results) {
    try {
      const successful = results.filter(r => r.success).length;
      const failed = results.filter(r => !r.success).length;

      // Log for each item
      for (const item of items) {
        await supabase
          .from('notification_logs')
          .insert({
            user_id: userId,
            item_id: item.id,
            notification_type: type,
            title: type === 'expired' ? 'Expired Food Alert' : 'Food Expiring Soon',
            body: `${item.item_name} ${type === 'expired' ? 'has expired' : 'is expiring soon'}`,
            data: { item },
            success: successful > 0,
            error_message: failed > 0 ? `Failed to send to ${failed} device(s)` : null
          });
      }
    } catch (error) {
      console.error('Error logging notification:', error);
    }
  }

  // Check and send timezone-aware notifications
  async checkAndSendTimezoneAwareNotifications() {
    try {
      // Get all users with timezone preferences
      const { data: preferences, error } = await supabase
        .from('notification_preferences')
        .select('*')
        .eq('enabled', true);

      if (error || !preferences) return;

      const currentTime = moment();

      for (const pref of preferences) {
        const userTime = moment.tz(pref.timezone || 'America/Los_Angeles');
        const notificationTime = moment.tz(
          `${userTime.format('YYYY-MM-DD')} ${pref.notification_time || '09:00:00'}`,
          pref.timezone || 'America/Los_Angeles'
        );

        // Check if it's within 30 minutes of the user's preferred notification time
        const minutesDiff = Math.abs(userTime.diff(notificationTime, 'minutes'));

        if (minutesDiff <= 30) {
          // Check if not in quiet hours
          const quietStart = moment.tz(
            `${userTime.format('YYYY-MM-DD')} ${pref.quiet_hours_start || '22:00:00'}`,
            pref.timezone || 'America/Los_Angeles'
          );
          const quietEnd = moment.tz(
            `${userTime.format('YYYY-MM-DD')} ${pref.quiet_hours_end || '08:00:00'}`,
            pref.timezone || 'America/Los_Angeles'
          );

          if (userTime.isBefore(quietStart) && userTime.isAfter(quietEnd)) {
            await this.processUserExpiryNotifications(
              pref.user_id,
              pref.days_before_expiry || [1, 3]
            );
          }
        }
      }
    } catch (error) {
      console.error('Error in timezone-aware notifications:', error);
    }
  }

  // Manual trigger for testing
  async testNotification(userId) {
    try {
      // Get a sample of items for testing
      const { data: items, error } = await supabase
        .from('fridge_items')
        .select('id, item_name, expiration_date, quantity')
        .eq('user_id', userId)
        .is('deleted_at', null)
        .limit(3);

      if (error || !items || items.length === 0) {
        console.log('No items found for test notification');
        return false;
      }

      const results = await pushNotificationService.sendExpiryNotification(userId, items);
      await this.logNotification(userId, items, 'test', results);

      return true;
    } catch (error) {
      console.error('Error sending test notification:', error);
      return false;
    }
  }
}

// Export singleton instance
module.exports = new ExpiryNotificationScheduler();