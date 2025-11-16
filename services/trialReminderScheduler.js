/**
 * Trial Reminder Scheduler
 * Runs daily to check for trials ending in 1 day and sends reminder emails
 */

const cron = require('node-cron');
const { getServiceClient } = require('../config/supabase');
const emailService = require('./emailService');

/**
 * Check for trials ending in 1 day and send reminder emails
 */
async function checkTrialsEndingTomorrow() {
  try {
    console.log('[TrialReminder] Checking for trials ending in 1 day...');

    const supabase = getServiceClient();

    // Calculate tomorrow's date range (start and end of tomorrow)
    const now = new Date();
    const tomorrowStart = new Date(now);
    tomorrowStart.setDate(now.getDate() + 1);
    tomorrowStart.setHours(0, 0, 0, 0);

    const tomorrowEnd = new Date(tomorrowStart);
    tomorrowEnd.setHours(23, 59, 59, 999);

    console.log('[TrialReminder] Looking for trials ending between:', tomorrowStart.toISOString(), 'and', tomorrowEnd.toISOString());

    // Query subscriptions with trials ending tomorrow
    const { data: subscriptions, error } = await supabase
      .from('subscriptions')
      .select(`
        id,
        user_id,
        trial_end,
        status,
        users (
          email,
          first_name
        )
      `)
      .eq('status', 'trialing')
      .gte('trial_end', tomorrowStart.toISOString())
      .lte('trial_end', tomorrowEnd.toISOString());

    if (error) {
      console.error('[TrialReminder] Error querying trials:', error);
      return;
    }

    if (!subscriptions || subscriptions.length === 0) {
      console.log('[TrialReminder] No trials ending tomorrow');
      return;
    }

    console.log(`[TrialReminder] Found ${subscriptions.length} trial(s) ending tomorrow`);

    // Send reminder email to each user
    for (const subscription of subscriptions) {
      if (!subscription.users) {
        console.error('[TrialReminder] No user found for subscription:', subscription.id);
        continue;
      }

      const user = subscription.users;
      const trialEndDate = new Date(subscription.trial_end);

      console.log(`[TrialReminder] Sending reminder to ${user.email} (trial ends ${trialEndDate.toLocaleDateString()})`);

      await emailService.sendTrialEndingEmail(user, trialEndDate);
    }

    console.log('[TrialReminder] Trial reminder check completed');
  } catch (error) {
    console.error('[TrialReminder] Error in trial reminder scheduler:', error);
  }
}

/**
 * Start the trial reminder scheduler
 * Runs daily at 9:00 AM
 */
function startScheduler() {
  // Run daily at 9:00 AM (server time)
  // Cron format: minute hour day month weekday
  const cronSchedule = '0 9 * * *'; // 9:00 AM every day

  console.log('[TrialReminder] Starting trial reminder scheduler (runs daily at 9:00 AM)');

  cron.schedule(cronSchedule, async () => {
    console.log('[TrialReminder] Scheduled task running...');
    await checkTrialsEndingTomorrow();
  });

  // Also run immediately on startup for testing (optional)
  if (process.env.NODE_ENV !== 'production') {
    console.log('[TrialReminder] Running initial check (development mode)...');
    // Uncomment the line below to run on startup in development
    // checkTrialsEndingTomorrow();
  }

  console.log('[TrialReminder] Scheduler initialized successfully');
}

/**
 * Manual trigger for testing
 */
async function runNow() {
  console.log('[TrialReminder] Manual trigger requested');
  await checkTrialsEndingTomorrow();
}

module.exports = {
  startScheduler,
  checkTrialsEndingTomorrow,
  runNow
};
