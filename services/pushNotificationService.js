const webpush = require('web-push');
const { createClient } = require('@supabase/supabase-js');
const expoPushService = require('./expoPushService');

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

  // === MOBILE PUSH TOKEN MANAGEMENT ===
  // These methods operate on the separate mobile_push_tokens table.
  // They do NOT touch push_subscriptions.

  async saveMobileToken(userId, expoToken, deviceName = null) {
    try {
      if (!expoPushService.isValidToken(expoToken)) {
        throw new Error('Invalid Expo push token format');
      }

      const { data: existing } = await supabase
        .from('mobile_push_tokens')
        .select('id')
        .eq('user_id', userId)
        .eq('expo_token', expoToken)
        .single();

      if (existing) {
        const { error } = await supabase
          .from('mobile_push_tokens')
          .update({ device_name: deviceName, updated_at: new Date().toISOString() })
          .eq('id', existing.id);
        if (error) throw error;
        return { success: true, message: 'Mobile token updated' };
      }

      const { error } = await supabase
        .from('mobile_push_tokens')
        .insert({
          user_id: userId,
          expo_token: expoToken,
          device_name: deviceName,
          created_at: new Date().toISOString(),
        });
      if (error) throw error;
      return { success: true, message: 'Mobile token registered' };
    } catch (error) {
      console.error('[PushService] Error saving mobile token:', error);
      throw error;
    }
  }

  async removeMobileToken(userId, expoToken) {
    try {
      if (!userId) {
        throw new Error('userId is required to remove a mobile token');
      }
      const { error } = await supabase
        .from('mobile_push_tokens')
        .delete()
        .eq('user_id', userId)
        .eq('expo_token', expoToken);
      if (error) throw error;
      return { success: true, message: 'Mobile token removed' };
    } catch (error) {
      console.error('[PushService] Error removing mobile token:', error);
      throw error;
    }
  }

  async getUserMobileTokens(userId) {
    try {
      const { data, error } = await supabase
        .from('mobile_push_tokens')
        .select('*')
        .eq('user_id', userId);
      if (error) throw error;
      return data || [];
    } catch (error) {
      console.error('[PushService] Error fetching mobile tokens:', error);
      return [];
    }
  }

  async sendExpoNotification(expoToken, payload) {
    const expoPayload = {
      title: payload.title,
      body: payload.body,
      data: {
        ...(payload.data || {}),
        screen: this.mapUrlToMobileRoute(payload.data?.url),
      },
      sound: 'default',
      badge: 1,
      channelId: this.mapTagToChannel(payload.tag),
      priority: payload.requireInteraction ? 'high' : 'default',
    };

    const results = await expoPushService.sendNotifications(
      [expoToken],
      expoPayload
    );

    const result = results[0];
    if (result && !result.success && result.error === 'DeviceNotRegistered') {
      await this.removeInvalidMobileToken(expoToken);
    }

    return {
      success: result?.success || false,
      platform: 'expo',
      error: result?.error || null,
    };
  }

  mapUrlToMobileRoute(url) {
    if (!url) return '/(tabs)/inventory';
    const routes = {
      '/inventory': '/(tabs)/inventory',
      '/mealplans': '/(tabs)/meals',
      '/recipes': '/(tabs)/meals',
      '/shopping-lists': '/(tabs)/meals',
    };
    return routes[url] || '/(tabs)/inventory';
  }

  mapTagToChannel(tag) {
    if (!tag) return 'default';
    if (tag.includes('expir')) return 'expiry-alerts';
    if (tag.includes('reminder')) return 'daily-reminders';
    return 'default';
  }

  async removeInvalidMobileToken(expoToken) {
    try {
      const { error } = await supabase
        .from('mobile_push_tokens')
        .delete()
        .eq('expo_token', expoToken);
      if (error) throw error;
      console.log('[PushService] Removed invalid mobile token:', expoToken.substring(0, 30));
    } catch (error) {
      console.error('[PushService] Error removing invalid mobile token:', error);
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

  // Send notification to all user's devices (web + mobile)
  async sendToUser(userId, payload) {
    const results = [];

    // 1. Web subscriptions (EXISTING behavior, unchanged)
    const subscriptions = await this.getUserSubscriptions(userId);
    for (const sub of subscriptions) {
      const subscriptionObject = {
        endpoint: sub.endpoint,
        keys: sub.keys
      };
      const result = await this.sendNotification(subscriptionObject, payload);
      results.push({ ...result, platform: 'web' });
    }

    // 2. Mobile tokens (NEW, additive only)
    try {
      const mobileTokens = await this.getUserMobileTokens(userId);
      for (const tokenRecord of mobileTokens) {
        try {
          const result = await this.sendExpoNotification(tokenRecord.expo_token, payload);
          results.push(result);
        } catch (mobileError) {
          console.error('[PushService] Error sending to mobile token:', mobileError.message);
          results.push({ success: false, platform: 'expo', error: mobileError.message });
        }
      }
    } catch (mobileQueryError) {
      // Mobile failure cannot break web notifications
      console.error('[PushService] Error querying mobile tokens:', mobileQueryError.message);
    }

    return results;
  }

  // Send expiry notifications
  async sendExpiryNotification(userId, items, userName = 'Hey') {
    const itemCount = items.length;
    let title = `${userName}, your food's about to expire`;
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

  // Get user's email notification preferences
  async getEmailPreferences(userId) {
    try {
      const { data, error } = await supabase
        .from('notification_preferences')
        .select('email_daily_expiry, email_weekly_summary, email_tips_updates, last_daily_email_sent, last_weekly_email_sent, last_tips_email_sent')
        .eq('user_id', userId)
        .single();

      if (error && error.code !== 'PGRST116') throw error; // PGRST116 = no rows

      // Return defaults if no preferences exist
      return data || {
        email_daily_expiry: true,
        email_weekly_summary: true,
        email_tips_updates: true,
        last_daily_email_sent: null,
        last_weekly_email_sent: null,
        last_tips_email_sent: null
      };
    } catch (error) {
      console.error('Error fetching email preferences:', error);
      return {
        email_daily_expiry: true,
        email_weekly_summary: true,
        email_tips_updates: true,
        last_daily_email_sent: null,
        last_weekly_email_sent: null,
        last_tips_email_sent: null
      };
    }
  }

  // Update email notification preferences
  async updateEmailPreferences(userId, emailPreferences) {
    try {
      const { error } = await supabase
        .from('notification_preferences')
        .upsert({
          user_id: userId,
          ...emailPreferences,
          updated_at: new Date().toISOString()
        });

      if (error) throw error;
      return { success: true, message: 'Email preferences updated successfully' };
    } catch (error) {
      console.error('Error updating email preferences:', error);
      throw error;
    }
  }
}

module.exports = new PushNotificationService();