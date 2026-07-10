/**
 * Streak Scheduler
 * - Every 30 min: timezone-aware sweep
 *     00:00–00:30 local  → overnight fallback (freeze consumption / streak break)
 *     09:00–09:30 local  → "streak lost" + "freeze used" notifications
 *     20:00–21:00 local  → "streak at risk" notification
 * - Monthly (1st, UTC): freeze refill (free: 1, premium: 3)
 *
 * All notifications dedupe through daily_reminder_logs (UNIQUE user_id, reminder_type,
 * sent_date) — the evening window spans two cron ticks and would double-fire otherwise.
 * sent_date uses the USER'S local date, not the server's.
 */

const cron = require('node-cron');
const moment = require('moment-timezone');
const { getServiceClient } = require('../config/supabase');
const streakService = require('./streakService');
const pushNotificationService = require('./pushNotificationService');

const DEFAULT_TIMEZONE = streakService.DEFAULT_TIMEZONE;

const REMINDER_TYPES = {
  AT_RISK: 'streak_at_risk',
  LOST: 'streak_lost',
  FREEZE_USED: 'streak_freeze_used'
};

class StreakScheduler {
  constructor() {
    this.isRunning = false;
    this.sweepTask = null;
    this.monthlyTask = null;
  }

  start() {
    if (this.isRunning) {
      console.log('[Streak] Scheduler already running');
      return;
    }

    this.sweepTask = cron.schedule('*/30 * * * *', async () => {
      try {
        await streakService.processOvernight();
        await this.sendStreakNotifications();
      } catch (error) {
        console.error('[Streak] Sweep error:', error);
      }
    });

    this.monthlyTask = cron.schedule('0 0 1 * *', async () => {
      try {
        await streakService.resetMonthlyFreezes();
      } catch (error) {
        console.error('[Streak] Monthly reset error:', error);
      }
    });

    this.isRunning = true;
  }

  stop() {
    if (this.sweepTask) { this.sweepTask.stop(); this.sweepTask = null; }
    if (this.monthlyTask) { this.monthlyTask.stop(); this.monthlyTask = null; }
    this.isRunning = false;
  }

  async sendStreakNotifications() {
    const supabase = getServiceClient();

    const { data: rows, error } = await supabase
      .from('user_streaks')
      .select('*, users!inner(timezone, first_name)')
      .or('current_streak.gt.0,lost_streak_value.not.is.null');

    if (error) {
      console.error('[Streak] Notification query failed:', error.message);
      return;
    }

    let sent = 0;
    for (const row of rows || []) {
      try {
        const timezone = row.users?.timezone || DEFAULT_TIMEZONE;
        const localNow = moment.tz(timezone);
        const localToday = localNow.format('YYYY-MM-DD');
        const localYesterday = localNow.clone().subtract(1, 'day').format('YYYY-MM-DD');
        const hour = localNow.hour();

        if (await this.streakRemindersDisabled(row.user_id)) continue;

        // Evening (8–9 PM local): streak at risk — no activity today and no freeze protection
        if (hour === 20
            && row.current_streak > 0
            && row.last_activity_date < localToday
            && row.freezes_available === 0) {
          const isFriday = localNow.day() === 5;
          const body = isFriday
            ? `Don't let the weekend break your ${row.current_streak}-day streak! Log something before midnight.`
            : `Your ${row.current_streak}-day streak is at risk! Open Trackabite to keep it going.`;
          sent += await this.sendOnce(row.user_id, REMINDER_TYPES.AT_RISK, localToday, {
            title: '🔥 Streak at risk!',
            body
          });
        }

        // Morning (9:00–9:30 local): streak lost yesterday
        if (hour === 9 && localNow.minute() < 30
            && row.current_streak === 0
            && row.lost_streak_value != null
            && row.lost_streak_date === localYesterday) {
          const graceActive = row.grace_period_expires_at && new Date(row.grace_period_expires_at) > new Date();
          const body = graceActive
            ? `Your ${row.lost_streak_value}-day streak ended — you have 3 days to restore it!`
            : `Your streak ended at ${row.lost_streak_value} days. Start a new one today!`;
          sent += await this.sendOnce(row.user_id, REMINDER_TYPES.LOST, localToday, {
            title: '💔 Streak lost',
            body
          });
        }

        // Morning (9:00–9:30 local): a freeze saved the streak overnight
        if (hour === 9 && localNow.minute() < 30 && row.current_streak > 0) {
          const { data: frozenYesterday } = await supabase
            .from('streak_daily_log')
            .select('id')
            .eq('user_id', row.user_id)
            .eq('date', localYesterday)
            .eq('status', 'frozen')
            .maybeSingle();

          if (frozenYesterday) {
            sent += await this.sendOnce(row.user_id, REMINDER_TYPES.FREEZE_USED, localToday, {
              title: '❄️ Streak Freeze used',
              body: `A Streak Freeze saved your ${row.current_streak}-day streak! ${row.freezes_available} left this month.`
            });
          }
        }
      } catch (err) {
        console.error(`[Streak] Notification failed for user ${row.user_id}:`, err.message);
      }
    }

    if (sent > 0) {
      console.log(`[Streak] Sent ${sent} streak notifications`);
    }
  }

  /** streak_reminders toggle in notification_preferences.daily_reminders JSONB; default enabled */
  async streakRemindersDisabled(userId) {
    const supabase = getServiceClient();
    const { data: pref } = await supabase
      .from('notification_preferences')
      .select('enabled, daily_reminders')
      .eq('user_id', userId)
      .maybeSingle();

    if (!pref) return false; // no prefs row — default to enabled
    if (pref.enabled === false) return true;
    return pref.daily_reminders?.streak_reminders?.enabled === false;
  }

  /** Send deduped via daily_reminder_logs (user-local sent_date). Returns 1 if sent, 0 otherwise. */
  async sendOnce(userId, reminderType, localDate, { title, body }) {
    const supabase = getServiceClient();

    const { data: existing } = await supabase
      .from('daily_reminder_logs')
      .select('id')
      .eq('user_id', userId)
      .eq('reminder_type', reminderType)
      .eq('sent_date', localDate)
      .maybeSingle();

    if (existing) return 0;

    // Claim the slot BEFORE sending — the unique constraint makes concurrent ticks safe
    const { error: claimError } = await supabase
      .from('daily_reminder_logs')
      .insert({ user_id: userId, reminder_type: reminderType, sent_date: localDate, success: true });

    if (claimError) return 0; // another tick got there first

    const results = await pushNotificationService.sendToUser(userId, {
      title,
      body,
      icon: '/logo192.png',
      badge: '/logo192.png',
      tag: reminderType,
      data: { screen: 'home', type: reminderType }
    });

    const anySuccess = Array.isArray(results) && results.some(r => r.success);
    if (!anySuccess) {
      await supabase
        .from('daily_reminder_logs')
        .update({ success: false })
        .eq('user_id', userId)
        .eq('reminder_type', reminderType)
        .eq('sent_date', localDate);
    }

    return anySuccess ? 1 : 0;
  }
}

module.exports = new StreakScheduler();
