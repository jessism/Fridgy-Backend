/**
 * Streak Scheduler
 * - Every 30 min: timezone-aware sweep
 *     00:00–00:30 local  → overnight fallback (freeze consumption / streak break)
 *     09:00–09:30 local  → "streak lost" + "freeze used" notifications
 *     20:00–21:00 local  → "streak at risk" notification
 * - Monthly (1st, UTC): freeze refill (free: 1, premium: 3)
 *
 * The 20:00 at-risk push is tier 3 of the daily engagement system (tiers 1 and 2 are the
 * 12:30 / 17:30 daily_reminders). It only fires when the user has done none of the six
 * qualifying actions today, so it self-suppresses whenever the earlier tiers worked. It
 * covers anyone active within ACTIVE_WINDOW_DAYS — including streak 0, who get a "start a
 * streak" variant — and warns freeze-holders before a freeze is silently spent.
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

// How recently a user must have acted to still be worth nudging at 8 PM. Bounds the
// at-risk push so it can reach streak-0 users without becoming a nightly nag forever.
const ACTIVE_WINDOW_DAYS = 7;

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

    // Recency cap: users active in the last 7 days are eligible for the at-risk nudge
    // even at streak 0 — they previously got nothing and so never started a first streak.
    // Anyone dormant longer than that is deliberately excluded; a nightly "start your
    // streak" push to a lapsed user is spam, and belongs to a win-back flow instead.
    const activeCutoff = moment().subtract(ACTIVE_WINDOW_DAYS, 'days').format('YYYY-MM-DD');

    const { data: rows, error } = await supabase
      .from('user_streaks')
      .select('*, users!inner(timezone, first_name)')
      .or(`current_streak.gt.0,lost_streak_value.not.is.null,last_activity_date.gte.${activeCutoff}`);

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

        // Evening (8–9 PM local): nothing logged today yet. Three audiences —
        // an active streak with no freeze, an active streak where a freeze is about to
        // be spent silently, and a recently-active user with no streak at all.
        const localCutoff = localNow.clone().subtract(ACTIVE_WINDOW_DAYS, 'days').format('YYYY-MM-DD');
        const recentlyActive = row.last_activity_date && row.last_activity_date >= localCutoff;

        if (hour === 20
            && recentlyActive
            && row.last_activity_date < localToday) {
          const isFriday = localNow.day() === 5;
          let title = '🔥 Streak at risk!';
          let body;

          if (row.current_streak === 0) {
            title = '🔥 Start a streak';
            body = 'Log a meal, add to your fridge, or save a recipe today to start a new streak!';
          } else if (row.freezes_available > 0) {
            // Warn before the freeze is consumed overnight, so spending it is a choice
            body = `No activity today — a Streak Freeze will be spent to save your ${row.current_streak}-day streak. Log something to keep it instead.`;
          } else if (isFriday) {
            body = `Don't let the weekend break your ${row.current_streak}-day streak! Log something before midnight.`;
          } else {
            body = `Your ${row.current_streak}-day streak is at risk! Open Trackabite to keep it going.`;
          }

          sent += await this.sendOnce(row.user_id, REMINDER_TYPES.AT_RISK, localToday, { title, body });
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
      data: { screen: '/(tabs)', type: reminderType }
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
