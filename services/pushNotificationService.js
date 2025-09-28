const webpush = require('web-push');
const { createClient } = require('@supabase/supabase-js');

// Initialize Supabase
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY
);

// Configure web-push with VAPID details
webpush.setVapidDetails(
  process.env.VAPID_SUBJECT || 'mailto:notifications@trackabite.app',
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

class PushNotificationService {
  // Save subscription to database
  async saveSubscription(userId, subscription) {
    try {
      // Check if subscription already exists
      const { data: existing } = await supabase
        .from('push_subscriptions')
        .select('id')
        .eq('user_id', userId)
        .eq('endpoint', subscription.endpoint)
        .single();

      if (existing) {
        // Update existing subscription
        const { data, error } = await supabase
          .from('push_subscriptions')
          .update({
            keys: subscription.keys,
            updated_at: new Date().toISOString()
          })
          .eq('id', existing.id);

        if (error) throw error;
        return { success: true, message: 'Subscription updated' };
      }

      // Create new subscription
      const { data, error } = await supabase
        .from('push_subscriptions')
        .insert({
          user_id: userId,
          endpoint: subscription.endpoint,
          keys: subscription.keys,
          created_at: new Date().toISOString()
        });

      if (error) throw error;
      return { success: true, message: 'Subscription saved' };
    } catch (error) {
      console.error('Error saving subscription:', error);
      throw error;
    }
  }

  // Remove subscription from database
  async removeSubscription(userId, endpoint) {
    try {
      const { error } = await supabase
        .from('push_subscriptions')
        .delete()
        .eq('user_id', userId)
        .eq('endpoint', endpoint);

      if (error) throw error;
      return { success: true, message: 'Subscription removed' };
    } catch (error) {
      console.error('Error removing subscription:', error);
      throw error;
    }
  }

  // Get user's subscriptions
  async getUserSubscriptions(userId) {
    try {
      const { data, error } = await supabase
        .from('push_subscriptions')
        .select('*')
        .eq('user_id', userId);

      if (error) throw error;
      return data || [];
    } catch (error) {
      console.error('Error fetching subscriptions:', error);
      return [];
    }
  }

  // Send notification to a specific subscription
  async sendNotification(subscription, payload) {
    try {
      await webpush.sendNotification(subscription, JSON.stringify(payload));
      return { success: true };
    } catch (error) {
      console.error('Error sending notification:', error);

      // If subscription is invalid, remove it
      if (error.statusCode === 410) {
        await this.removeInvalidSubscription(subscription.endpoint);
      }

      return { success: false, error: error.message };
    }
  }

  // Send notification to all user's devices
  async sendToUser(userId, payload) {
    const subscriptions = await this.getUserSubscriptions(userId);
    const results = [];

    for (const sub of subscriptions) {
      const subscriptionObject = {
        endpoint: sub.endpoint,
        keys: sub.keys
      };

      const result = await this.sendNotification(subscriptionObject, payload);
      results.push(result);
    }

    return results;
  }

  // Send expiry notifications
  async sendExpiryNotification(userId, items) {
    const itemCount = items.length;
    let title = 'Food Expiring Soon!';
    let body = '';

    if (itemCount === 1) {
      body = `Your ${items[0].item_name} expires ${this.getExpiryText(items[0].expiration_date)}`;
    } else if (itemCount <= 3) {
      const itemNames = items.map(i => i.item_name).join(', ');
      body = `${itemCount} items expiring soon: ${itemNames}`;
    } else {
      body = `You have ${itemCount} items expiring soon. Check your inventory!`;
    }

    const payload = {
      title,
      body,
      icon: '/logo192.png',
      badge: '/logo192.png',
      tag: 'expiry-notification',
      data: {
        url: '/inventory',
        items: items.map(i => ({
          name: i.item_name,
          expiryDate: i.expiration_date
        }))
      },
      requireInteraction: true
    };

    return await this.sendToUser(userId, payload);
  }

  // Helper to get expiry text
  getExpiryText(expirationDate) {
    const now = new Date();
    const expiry = new Date(expirationDate);
    const daysUntil = Math.ceil((expiry - now) / (1000 * 60 * 60 * 24));

    if (daysUntil === 0) return 'today';
    if (daysUntil === 1) return 'tomorrow';
    if (daysUntil < 0) return 'already expired';
    return `in ${daysUntil} days`;
  }

  // Remove invalid subscription
  async removeInvalidSubscription(endpoint) {
    try {
      const { error } = await supabase
        .from('push_subscriptions')
        .delete()
        .eq('endpoint', endpoint);

      if (error) throw error;
      console.log('Removed invalid subscription:', endpoint);
    } catch (error) {
      console.error('Error removing invalid subscription:', error);
    }
  }

  // Test notification
  async sendTestNotification(userId) {
    const payload = {
      title: 'Test Notification',
      body: 'Push notifications are working! You\'ll receive reminders when your food is about to expire.',
      icon: '/logo192.png',
      badge: '/logo192.png',
      tag: 'test-notification',
      vibrate: [200, 100, 200]
    };

    return await this.sendToUser(userId, payload);
  }

  // Get user's notification preferences
  async getUserPreferences(userId) {
    try {
      const { data, error } = await supabase
        .from('notification_preferences')
        .select('*')
        .eq('user_id', userId)
        .single();

      if (error && error.code !== 'PGRST116') throw error; // PGRST116 = no rows

      // Return defaults if no preferences exist
      return data || {
        enabled: true,
        days_before_expiry: [1, 3],
        notification_time: '09:00',
        timezone: 'America/Los_Angeles'
      };
    } catch (error) {
      console.error('Error fetching preferences:', error);
      return {
        enabled: true,
        days_before_expiry: [1, 3],
        notification_time: '09:00',
        timezone: 'America/Los_Angeles'
      };
    }
  }

  // Update notification preferences
  async updateUserPreferences(userId, preferences) {
    try {
      const { error } = await supabase
        .from('notification_preferences')
        .upsert({
          user_id: userId,
          ...preferences,
          updated_at: new Date().toISOString()
        });

      if (error) throw error;
      return { success: true };
    } catch (error) {
      console.error('Error updating preferences:', error);
      throw error;
    }
  }

  // Send a daily reminder notification
  async sendDailyReminder(userId, reminderType, config) {
    const emoji = config.emoji || '📱';
    const message = config.message || "Check your Trackabite app!";

    // Determine URL based on reminder type
    let url = '/inventory';
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

    return await this.sendToUser(userId, payload);
  }

  // Get user's daily reminder preferences
  async getUserDailyReminders(userId) {
    try {
      const { data, error } = await supabase
        .from('notification_preferences')
        .select('daily_reminders, timezone')
        .eq('user_id', userId)
        .single();

      if (error && error.code !== 'PGRST116') throw error;

      // Return defaults if no preferences exist
      return data?.daily_reminders || {
        inventory_check: {
          enabled: true,
          time: '17:30',
          message: "See what's in your fridge",
          emoji: '🥗'
        }
      };
    } catch (error) {
      console.error('Error fetching daily reminders:', error);
      return {
        inventory_check: {
          enabled: true,
          time: '17:30',
          message: "See what's in your fridge",
          emoji: '🥗'
        }
      };
    }
  }

  // Update daily reminder preferences
  async updateDailyReminders(userId, dailyReminders) {
    try {
      const { error } = await supabase
        .from('notification_preferences')
        .upsert({
          user_id: userId,
          daily_reminders: dailyReminders,
          updated_at: new Date().toISOString()
        });

      if (error) throw error;
      return { success: true };
    } catch (error) {
      console.error('Error updating daily reminders:', error);
      throw error;
    }
  }
}

module.exports = new PushNotificationService();