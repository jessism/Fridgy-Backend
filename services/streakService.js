/**
 * Streak Service
 * Duolingo-style daily streaks: any food action counts, auto-freezes,
 * 3-day grace restore (premium), milestones.
 *
 * All streak mutation goes through the record_streak_action Postgres function
 * (migration 070) so concurrent actions cannot double-increment. This module is
 * a thin wrapper plus read endpoints and the scheduler-facing batch operations.
 */

const moment = require('moment-timezone');
const { getServiceClient } = require('../config/supabase');
const subscriptionService = require('./subscriptionService');

const DEFAULT_TIMEZONE = 'America/Los_Angeles';
const MILESTONES = [3, 7, 14, 30, 60, 90, 365];

/**
 * Record a streak-counting action. Fire-and-forget from controllers:
 *   streakService.recordAction(userId, 'meal_log').catch(err => console.error('[Streak]', err));
 */
async function recordAction(userId, actionType) {
  const supabase = getServiceClient();

  let isPremium = false;
  try {
    isPremium = await subscriptionService.isPremium(userId);
  } catch (err) {
    console.error('[Streak] isPremium check failed, treating as free:', err.message);
  }

  const { data, error } = await supabase.rpc('record_streak_action', {
    p_user_id: userId,
    p_action_type: actionType,
    p_is_premium: isPremium
  });

  if (error) {
    throw new Error(`record_streak_action failed: ${error.message}`);
  }

  return data; // { current_streak, longest_streak, streak_incremented, new_milestone, today_status, freezes_available }
}

/**
 * recordAction guarded against back-dating: meal logs accept a targetDate, and a
 * back-dated log must never feed the streak (it would be a free streak repair,
 * undercutting the premium-only grace restore). Only records when targetDate is
 * absent or resolves to the user's local today.
 */
async function recordActionForDate(userId, actionType, targetDate) {
  if (targetDate) {
    const supabase = getServiceClient();
    const { data: user } = await supabase.from('users').select('timezone').eq('id', userId).single();
    const tz = user?.timezone || DEFAULT_TIMEZONE;
    const localToday = moment.tz(tz).format('YYYY-MM-DD');
    const targetLocal = moment.tz(new Date(targetDate), tz).format('YYYY-MM-DD');
    if (targetLocal !== localToday) {
      return null;
    }
  }
  return recordAction(userId, actionType);
}

/**
 * Current streak state + today's status + undismissed milestones.
 * Read-only: a user with no row gets zeros without creating one.
 */
async function getStreak(userId) {
  const supabase = getServiceClient();

  const [{ data: streak }, { data: user }] = await Promise.all([
    supabase.from('user_streaks').select('*').eq('user_id', userId).maybeSingle(),
    supabase.from('users').select('timezone').eq('id', userId).single()
  ]);

  const timezone = user?.timezone || DEFAULT_TIMEZONE;
  const today = moment.tz(timezone).format('YYYY-MM-DD');

  let isPremium = false;
  try {
    isPremium = await subscriptionService.isPremium(userId);
  } catch (err) {
    console.error('[Streak] isPremium check failed in getStreak:', err.message);
  }

  const [{ data: todayLog }, { data: pendingMilestones }] = await Promise.all([
    supabase.from('streak_daily_log').select('status').eq('user_id', userId).eq('date', today).maybeSingle(),
    supabase.from('streak_milestones').select('id, milestone, badge_type, achieved_at')
      .eq('user_id', userId).eq('dismissed', false).order('achieved_at', { ascending: true })
  ]);

  const graceActive = !!(streak?.grace_period_expires_at
    && new Date(streak.grace_period_expires_at) > new Date()
    && streak.lost_streak_value != null);

  return {
    currentStreak: streak?.current_streak || 0,
    longestStreak: streak?.longest_streak || 0,
    lastActivityDate: streak?.last_activity_date || null,
    streakStartedAt: streak?.streak_started_at || null,
    freezesAvailable: streak?.freezes_available ?? (isPremium ? 3 : 1),
    todayStatus: todayLog?.status || 'none',
    lostStreakValue: graceActive ? streak.lost_streak_value : null,
    gracePeriodExpiresAt: graceActive ? streak.grace_period_expires_at : null,
    canRestore: graceActive && isPremium,
    pendingMilestones: pendingMilestones || []
  };
}

/** Daily log rows for a date range (drives the premium calendar). */
async function getCalendar(userId, startDate, endDate) {
  const supabase = getServiceClient();
  const { data, error } = await supabase
    .from('streak_daily_log')
    .select('date, status, action_type, action_count, freeze_used')
    .eq('user_id', userId)
    .gte('date', startDate)
    .lte('date', endDate)
    .order('date', { ascending: true });

  if (error) throw new Error(`getCalendar failed: ${error.message}`);
  return data || [];
}

async function getMilestones(userId) {
  const supabase = getServiceClient();
  const { data, error } = await supabase
    .from('streak_milestones')
    .select('id, milestone, badge_type, achieved_at, dismissed')
    .eq('user_id', userId)
    .order('milestone', { ascending: true });

  if (error) throw new Error(`getMilestones failed: ${error.message}`);
  return data || [];
}

async function dismissMilestone(userId, milestoneId) {
  const supabase = getServiceClient();
  const { data, error } = await supabase
    .from('streak_milestones')
    .update({ dismissed: true })
    .eq('id', milestoneId)
    .eq('user_id', userId) // scoping: users can only dismiss their own
    .select()
    .maybeSingle();

  if (error) throw new Error(`dismissMilestone failed: ${error.message}`);
  return data;
}

/**
 * Overnight fallback for users who didn't open the app: for each user whose local
 * time is 00:00–00:30 and whose streak wasn't continued yesterday, consume a freeze
 * ('frozen' row) or break the streak ('missed' row + 3-day grace).
 * The record_streak_action RPC does the same lazily, so this only handles absent users.
 * Returns processed users for the scheduler's notification queue.
 */
async function processOvernight() {
  const supabase = getServiceClient();
  const results = { frozen: [], broken: [] };

  const { data: rows, error } = await supabase
    .from('user_streaks')
    .select('*, users!inner(timezone)')
    .gt('current_streak', 0);

  if (error) {
    console.error('[Streak] processOvernight query failed:', error.message);
    return results;
  }

  for (const row of rows || []) {
    try {
      const timezone = row.users?.timezone || DEFAULT_TIMEZONE;
      const localNow = moment.tz(timezone);

      // Only act in the first cron tick after local midnight
      if (localNow.hour() !== 0 || localNow.minute() >= 30) continue;

      const yesterday = localNow.clone().subtract(1, 'day').format('YYYY-MM-DD');
      if (row.last_activity_date >= yesterday) continue; // streak continued (or frozen already counted)

      // Idempotency: skip if yesterday was already processed (lazy catch-up or double cron fire)
      const { data: existing } = await supabase
        .from('streak_daily_log')
        .select('id')
        .eq('user_id', row.user_id)
        .eq('date', yesterday)
        .maybeSingle();
      if (existing) continue;

      if (row.freezes_available > 0) {
        const { error: insertError } = await supabase
          .from('streak_daily_log')
          .insert({ user_id: row.user_id, date: yesterday, status: 'frozen', freeze_used: true });
        if (insertError) continue; // lost a race with the RPC's lazy catch-up — already handled

        await supabase
          .from('user_streaks')
          .update({
            freezes_available: row.freezes_available - 1,
            freezes_used_total: (row.freezes_used_total || 0) + 1
          })
          .eq('user_id', row.user_id);

        results.frozen.push({ userId: row.user_id, timezone, currentStreak: row.current_streak, freezesLeft: row.freezes_available - 1 });
      } else {
        const { error: insertError } = await supabase
          .from('streak_daily_log')
          .insert({ user_id: row.user_id, date: yesterday, status: 'missed' });
        if (insertError) continue;

        await supabase
          .from('user_streaks')
          .update({
            current_streak: 0,
            lost_streak_value: row.current_streak,
            lost_streak_date: yesterday,
            grace_period_expires_at: moment().add(3, 'days').toISOString()
          })
          .eq('user_id', row.user_id);

        results.broken.push({ userId: row.user_id, timezone, lostStreak: row.current_streak });
      }
    } catch (err) {
      console.error(`[Streak] processOvernight failed for user ${row.user_id}:`, err.message);
    }
  }

  if (results.frozen.length || results.broken.length) {
    console.log(`[Streak] Overnight: ${results.frozen.length} frozen, ${results.broken.length} broken`);
  }
  return results;
}

/** Monthly refill: free -> 1, premium/grandfathered -> 3. Runs on the 1st (UTC). */
async function resetMonthlyFreezes() {
  const supabase = getServiceClient();

  const { data: premiumUsers, error } = await supabase
    .from('users')
    .select('id')
    .in('tier', ['premium', 'grandfathered']);

  if (error) {
    console.error('[Streak] resetMonthlyFreezes tier query failed:', error.message);
    return;
  }

  const premiumIds = (premiumUsers || []).map(u => u.id);
  const now = new Date().toISOString();

  if (premiumIds.length > 0) {
    await supabase
      .from('user_streaks')
      .update({ freezes_available: 3, freezes_last_reset_at: now })
      .in('user_id', premiumIds);
  }

  // Free users: everyone else with a streak row
  let freeQuery = supabase
    .from('user_streaks')
    .update({ freezes_available: 1, freezes_last_reset_at: now });
  if (premiumIds.length > 0) {
    freeQuery = freeQuery.not('user_id', 'in', `(${premiumIds.join(',')})`);
  } else {
    freeQuery = freeQuery.gte('freezes_available', 0); // update all
  }
  const { error: freeError } = await freeQuery;
  if (freeError) {
    console.error('[Streak] resetMonthlyFreezes free-tier update failed:', freeError.message);
  }

  console.log(`[Streak] Monthly freeze reset done (${premiumIds.length} premium users)`);
}

/**
 * Immediate freeze top-up when a user upgrades to premium
 * (called from the subscription tier-update path; monthly cron would otherwise
 * make mid-month upgraders wait weeks for their 3 freezes).
 */
async function topUpFreezesForPremium(userId) {
  const supabase = getServiceClient();
  const { data: streak } = await supabase
    .from('user_streaks')
    .select('freezes_available')
    .eq('user_id', userId)
    .maybeSingle();

  if (streak && streak.freezes_available < 3) {
    await supabase
      .from('user_streaks')
      .update({ freezes_available: 3 })
      .eq('user_id', userId);
    console.log(`[Streak] Topped up freezes to 3 for upgraded user ${userId}`);
  }
}

module.exports = {
  recordAction,
  recordActionForDate,
  getStreak,
  getCalendar,
  getMilestones,
  dismissMilestone,
  processOvernight,
  resetMonthlyFreezes,
  topUpFreezesForPremium,
  MILESTONES,
  DEFAULT_TIMEZONE
};
