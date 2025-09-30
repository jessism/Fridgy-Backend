const cron = require('node-cron');
const pushNotificationService = require('./pushNotificationService');
const { createClient } = require('@supabase/supabase-js');

// Initialize Supabase client
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

class TestNotificationScheduler {
  constructor() {
    this.testJobs = new Map(); // Store test jobs per user
    console.log('[Test Scheduler] Initialized');
  }

  // Start sending test notifications every 5 minutes
  async startTestNotifications(userId) {
    console.log(`[Test Scheduler] Starting 5-minute notifications for user ${userId}`);

    try {
      // Stop existing job if any
      this.stopTestNotifications(userId);

      // Get user info
      const { data: user, error } = await supabase
        .from('users')
        .select('name')
        .eq('id', userId)
        .single();

      if (error) {
        console.error('[Test Scheduler] Error fetching user:', error);
        throw new Error('Failed to fetch user information');
      }

      const userName = user?.name || 'there';
      console.log(`[Test Scheduler] User name: ${userName}`);

      // Send immediate notification
      await this.sendImmediateTest(userId, userName);

      // Schedule every 5 minutes (at :00, :05, :10, :15, etc.)
      const job = cron.schedule('*/5 * * * *', async () => {
        const now = new Date();
        const time = now.toLocaleTimeString('en-US', {
          hour: 'numeric',
          minute: '2-digit',
          hour12: true
        });

        const message = {
          title: '⏰ 5-Minute Test',
          body: `Hey ${userName}, right now is ${time}`,
          icon: '/logo192.png',
          badge: '/logo192.png',
          tag: 'test-5min',
          data: {
            type: 'test',
            timestamp: now.toISOString()
          }
        };

        console.log(`[Test Scheduler] Sending scheduled notification: ${message.body}`);

        try {
          const results = await pushNotificationService.sendNotificationToUser(userId, message);
          const successful = results.filter(r => r.success).length;
          const failed = results.filter(r => !r.success).length;
          console.log(`[Test Scheduler] Notification results: ${successful} sent, ${failed} failed`);
        } catch (error) {
          console.error(`[Test Scheduler] Failed to send notification:`, error);
        }
      });

      this.testJobs.set(userId, job);

      // Auto-stop after 1 hour
      setTimeout(() => {
        console.log(`[Test Scheduler] Auto-stopping test for user ${userId} after 1 hour`);
        this.stopTestNotifications(userId);
      }, 3600000); // 1 hour

      return {
        success: true,
        message: 'Test notifications started - every 5 minutes for the next hour',
        nextTime: this.getNextFiveMinuteMark(),
        userName: userName
      };
    } catch (error) {
      console.error('[Test Scheduler] Error starting test:', error);
      throw error;
    }
  }

  // Stop test notifications
  stopTestNotifications(userId) {
    const job = this.testJobs.get(userId);
    if (job) {
      job.stop();
      this.testJobs.delete(userId);
      console.log(`[Test Scheduler] Stopped notifications for user ${userId}`);
      return true;
    }
    return false;
  }

  // Send immediate test notification
  async sendImmediateTest(userId, userName) {
    const now = new Date();
    const time = now.toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      hour12: true
    });

    const message = {
      title: '🚀 Test Started!',
      body: `Hey ${userName}, notifications will arrive every 5 minutes. Current time: ${time}`,
      icon: '/logo192.png',
      badge: '/logo192.png',
      tag: 'test-start',
      vibrate: [200, 100, 200]
    };

    console.log(`[Test Scheduler] Sending immediate test: ${message.body}`);

    try {
      const results = await pushNotificationService.sendNotificationToUser(userId, message);
      const successful = results.filter(r => r.success).length;
      console.log(`[Test Scheduler] Immediate notification sent to ${successful} device(s)`);
      return results;
    } catch (error) {
      console.error('[Test Scheduler] Error sending immediate notification:', error);
      throw error;
    }
  }

  // Get next 5-minute mark
  getNextFiveMinuteMark() {
    const now = new Date();
    const minutes = now.getMinutes();
    const nextMinute = Math.ceil(minutes / 5) * 5;

    const nextTime = new Date(now);
    if (nextMinute === 60) {
      nextTime.setHours(nextTime.getHours() + 1);
      nextTime.setMinutes(0);
    } else {
      nextTime.setMinutes(nextMinute);
    }
    nextTime.setSeconds(0);

    return nextTime.toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      hour12: true
    });
  }

  // Check if test is running for user
  isTestRunning(userId) {
    return this.testJobs.has(userId);
  }

  // Get all active test users
  getActiveTests() {
    return Array.from(this.testJobs.keys());
  }
}

module.exports = new TestNotificationScheduler();