const cron = require('node-cron');
const moment = require('moment-timezone');
const { createClient } = require('@supabase/supabase-js');
const pushNotificationService = require('./pushNotificationService');
const emailService = require('./emailService');

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

    // Run every 30 minutes for timezone-aware notifications and daily reminders
    this.timezoneTask = cron.schedule('*/30 * * * *', async () => {
      console.log('Running timezone-aware checks (expiry + daily reminders + emails)...');
      await this.checkAndSendTimezoneAwareNotifications();
      await this.checkAndSendDailyReminders();
      await this.checkAndSendEmailNotifications();
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

  // Check and send daily reminders
  async checkAndSendDailyReminders() {
    try {
      console.log('Checking for daily reminders to send...');

      // Get all users with daily reminders enabled
      const { data: preferences, error } = await supabase
        .from('notification_preferences')
        .select('*')
        .eq('enabled', true);

      if (error || !preferences) {
        console.error('Error fetching preferences for daily reminders:', error);
        return;
      }

      const currentTime = moment();
      let remindersChecked = 0;
      let remindersSent = 0;

      for (const pref of preferences) {
        const userTime = moment.tz(pref.timezone || 'America/Los_Angeles');
        const dailyReminders = pref.daily_reminders || {};

        // Check each type of daily reminder
        for (const [reminderType, config] of Object.entries(dailyReminders)) {
          if (!config.enabled) continue;

          // Check if it's a weekly reminder (has a day property)
          if (config.day) {
            const currentDay = userTime.format('dddd');
            if (currentDay.toLowerCase() !== config.day.toLowerCase()) continue;
          }

          // Parse the reminder time
          const [hours, minutes] = (config.time || '17:30').split(':').map(Number);

          // Check if current time is within the 30-minute window for this reminder
          const currentHour = userTime.hour();
          const currentMinute = userTime.minute();

          if (currentHour === hours && currentMinute >= minutes && currentMinute < minutes + 30) {
            remindersChecked++;

            // Check if we haven't already sent this reminder today
            const { data: existingLog } = await supabase
              .from('daily_reminder_logs')
              .select('id')
              .eq('user_id', pref.user_id)
              .eq('reminder_type', reminderType)
              .eq('sent_date', moment().format('YYYY-MM-DD'))
              .single();

            if (!existingLog) {
              // Send the reminder
              const sent = await this.sendDailyReminder(
                pref.user_id,
                reminderType,
                config.message || "Check your Trackabite app!",
                config.emoji || '📱'
              );

              if (sent) {
                remindersSent++;
                // Log that we sent this reminder
                await supabase
                  .from('daily_reminder_logs')
                  .insert({
                    user_id: pref.user_id,
                    reminder_type: reminderType,
                    sent_date: moment().format('YYYY-MM-DD'),
                    success: true
                  });

                console.log(`Sent ${reminderType} reminder to user ${pref.user_id}`);
              }
            }
          }
        }
      }

      if (remindersChecked > 0) {
        console.log(`Daily reminders: Checked ${remindersChecked}, Sent ${remindersSent}`);
      }
    } catch (error) {
      console.error('Error in checkAndSendDailyReminders:', error);
    }
  }

  // Send a daily reminder notification
  async sendDailyReminder(userId, reminderType, message, emoji = '📱') {
    try {
      let url = '/inventory';

      // Customize URL based on reminder type
      if (reminderType === 'meal_planning') {
        url = '/mealplans';
      } else if (reminderType === 'shopping_reminder') {
        url = '/shopping-lists';
      } else if (reminderType === 'dinner_prep' || reminderType === 'breakfast_reminder' || reminderType === 'lunch_reminder') {
        url = '/recipes';
      }

      const payload = {
        title: `${emoji} Trackabite Reminder`,
        body: message,
        icon: '/logo192.png',
        badge: '/logo192.png',
        tag: `daily-reminder-${reminderType}`,
        data: {
          url,
          type: 'daily-reminder',
          reminderType
        },
        requireInteraction: false,
        vibrate: [200, 100, 200]
      };

      const results = await pushNotificationService.sendToUser(userId, payload);

      // Log to notification_logs as well
      await supabase
        .from('notification_logs')
        .insert({
          user_id: userId,
          notification_type: 'daily-reminder',
          reminder_type: reminderType,
          title: payload.title,
          body: payload.body,
          data: payload.data,
          success: results.some(r => r.success)
        });

      return results.some(r => r.success);
    } catch (error) {
      console.error(`Error sending daily reminder ${reminderType} to user ${userId}:`, error);
      return false;
    }
  }

  // Check and send email notifications at 7:45 AM user's time
  async checkAndSendEmailNotifications() {
    try {
      console.log('Checking for email notifications to send at 7:45 AM...');

      // Get all users with email notifications enabled
      const { data: preferences, error } = await supabase
        .from('notification_preferences')
        .select('*');

      if (error || !preferences) {
        console.error('Error fetching preferences for email notifications:', error);
        return;
      }

      let emailsChecked = 0;
      let emailsSent = 0;

      for (const pref of preferences) {
        const userTime = moment.tz(pref.timezone || 'America/Los_Angeles');
        const currentHour = userTime.hour();
        const currentMinute = userTime.minute();

        // Check if it's 7:45 AM in user's timezone (within 30-minute window from cron)
        if (currentHour === 7 && currentMinute >= 45) {
          emailsChecked++;

          // 1. Check for DAILY expiry email
          if (pref.email_daily_expiry) {
            const lastSent = pref.last_daily_email_sent ? moment(pref.last_daily_email_sent) : null;
            const today = moment().format('YYYY-MM-DD');
            const lastSentDate = lastSent ? lastSent.format('YYYY-MM-DD') : null;

            // Only send if we haven't sent today
            if (!lastSent || lastSentDate !== today) {
              const emailSent = await this.sendDailyExpiryEmail(pref.user_id);

              if (emailSent) {
                emailsSent++;
                // Update last_daily_email_sent timestamp
                await supabase
                  .from('notification_preferences')
                  .update({ last_daily_email_sent: new Date().toISOString() })
                  .eq('user_id', pref.user_id);

                console.log(`Sent daily expiry email to user ${pref.user_id}`);
              }
            }
          }

          // 2. Check for WEEKLY summary email (Sundays only)
          if (pref.email_weekly_summary && userTime.day() === 0) { // 0 = Sunday
            const lastSent = pref.last_weekly_email_sent ? moment(pref.last_weekly_email_sent) : null;
            const thisWeek = moment().week();
            const lastSentWeek = lastSent ? lastSent.week() : null;

            // Only send if we haven't sent this week
            if (!lastSent || lastSentWeek !== thisWeek) {
              const emailSent = await this.sendWeeklyExpiryEmail(pref.user_id);

              if (emailSent) {
                emailsSent++;
                // Update last_weekly_email_sent timestamp
                await supabase
                  .from('notification_preferences')
                  .update({ last_weekly_email_sent: new Date().toISOString() })
                  .eq('user_id', pref.user_id);

                console.log(`Sent weekly expiry email to user ${pref.user_id}`);
              }
            }
          }
        }
      }

      if (emailsChecked > 0) {
        console.log(`Email notifications: Checked ${emailsChecked} users, Sent ${emailsSent} emails`);
      }
    } catch (error) {
      console.error('Error in checkAndSendEmailNotifications:', error);
    }
  }

  // Send daily expiry email to a user
  async sendDailyExpiryEmail(userId) {
    try {
      // Get user details
      const { data: user, error: userError } = await supabase
        .from('users')
        .select('email, first_name, timezone')
        .eq('id', userId)
        .single();

      if (userError || !user) {
        console.error(`Error fetching user ${userId}:`, userError);
        return false;
      }

      // Get all expiring items (today, tomorrow, and next 7 days)
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const sevenDaysFromNow = new Date(today);
      sevenDaysFromNow.setDate(sevenDaysFromNow.getDate() + 7);

      const { data: items, error: itemsError } = await supabase
        .from('fridge_items')
        .select('id, item_name, expiration_date, quantity, category')
        .eq('user_id', userId)
        .is('deleted_at', null)
        .gte('expiration_date', today.toISOString().split('T')[0])
        .lte('expiration_date', sevenDaysFromNow.toISOString().split('T')[0]);

      if (itemsError) {
        console.error(`Error fetching items for user ${userId}:`, itemsError);
        return false;
      }

      // Only send if there are items expiring
      if (!items || items.length === 0) {
        console.log(`No expiring items for user ${userId}, skipping daily email`);
        return false;
      }

      // Send email via emailService
      await emailService.sendDailyExpiryEmail(user, items);

      // Log the email notification
      await supabase
        .from('notification_logs')
        .insert({
          user_id: userId,
          notification_type: 'daily-expiry-email',
          notification_method: 'email',
          title: 'Daily Expiry Reminder',
          body: `Sent email about ${items.length} expiring items`,
          data: { itemCount: items.length },
          success: true
        });

      return true;
    } catch (error) {
      console.error(`Error sending daily expiry email to user ${userId}:`, error);

      // Log the failed email
      await supabase
        .from('notification_logs')
        .insert({
          user_id: userId,
          notification_type: 'daily-expiry-email',
          notification_method: 'email',
          title: 'Daily Expiry Reminder',
          body: 'Failed to send',
          success: false,
          error_message: error.message
        })
        .catch(() => {}); // Ignore logging errors

      return false;
    }
  }

  // Send weekly expiry email to a user
  async sendWeeklyExpiryEmail(userId) {
    try {
      // Get user details
      const { data: user, error: userError } = await supabase
        .from('users')
        .select('email, first_name, timezone')
        .eq('id', userId)
        .single();

      if (userError || !user) {
        console.error(`Error fetching user ${userId}:`, userError);
        return false;
      }

      // Get all items expiring this week (next 7 days)
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const sevenDaysFromNow = new Date(today);
      sevenDaysFromNow.setDate(sevenDaysFromNow.getDate() + 7);

      const { data: items, error: itemsError } = await supabase
        .from('fridge_items')
        .select('id, item_name, expiration_date, quantity, category')
        .eq('user_id', userId)
        .is('deleted_at', null)
        .gte('expiration_date', today.toISOString().split('T')[0])
        .lte('expiration_date', sevenDaysFromNow.toISOString().split('T')[0]);

      if (itemsError) {
        console.error(`Error fetching items for user ${userId}:`, itemsError);
        return false;
      }

      // Only send if there are items expiring this week
      if (!items || items.length === 0) {
        console.log(`No items expiring this week for user ${userId}, skipping weekly email`);
        return false;
      }

      // Send email via emailService
      await emailService.sendWeeklyExpiryEmail(user, items);

      // Log the email notification
      await supabase
        .from('notification_logs')
        .insert({
          user_id: userId,
          notification_type: 'weekly-expiry-email',
          notification_method: 'email',
          title: 'Weekly Expiry Summary',
          body: `Sent weekly email about ${items.length} expiring items`,
          data: { itemCount: items.length },
          success: true
        });

      return true;
    } catch (error) {
      console.error(`Error sending weekly expiry email to user ${userId}:`, error);

      // Log the failed email
      await supabase
        .from('notification_logs')
        .insert({
          user_id: userId,
          notification_type: 'weekly-expiry-email',
          notification_method: 'email',
          title: 'Weekly Expiry Summary',
          body: 'Failed to send',
          success: false,
          error_message: error.message
        })
        .catch(() => {}); // Ignore logging errors

      return false;
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