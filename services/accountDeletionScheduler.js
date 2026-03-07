/**
 * Account Deletion Scheduler
 * Runs daily to process pending account deletions that have passed their 30-day grace period
 */

const cron = require('node-cron');
const { getServiceClient } = require('../config/supabase');

/**
 * Process pending account deletions
 * Finds accounts scheduled for deletion that have passed their grace period
 */
async function processAccountDeletions() {
  try {
    console.log('[AccountDeletion] Checking for accounts ready for deletion...');

    const supabase = getServiceClient();
    const now = new Date().toISOString();

    // Find all accounts scheduled for deletion that have passed their grace period
    const { data: accountsToDelete, error: fetchError } = await supabase
      .from('users')
      .select('id, email, first_name, deletion_requested_at, deletion_scheduled_for')
      .eq('deletion_status', 'pending')
      .lte('deletion_scheduled_for', now);

    if (fetchError) {
      console.error('[AccountDeletion] Error fetching accounts:', fetchError);
      return;
    }

    if (!accountsToDelete || accountsToDelete.length === 0) {
      console.log('[AccountDeletion] No accounts ready for deletion');
      return;
    }

    console.log(`[AccountDeletion] Found ${accountsToDelete.length} account(s) to delete`);

    // Process each account
    let successCount = 0;
    let errorCount = 0;

    for (const user of accountsToDelete) {
      try {
        console.log(`[AccountDeletion] Deleting account: ${user.email} (ID: ${user.id})`);
        console.log(`[AccountDeletion]   Requested: ${user.deletion_requested_at}`);
        console.log(`[AccountDeletion]   Scheduled: ${user.deletion_scheduled_for}`);

        // Delete user - CASCADE will handle related data:
        // - subscriptions (via FK)
        // - usage_limits (via FK)
        // - recipes (via FK)
        // - fridge_items (via FK)
        // - meal_plans (via FK)
        // - shopping_lists (via FK)
        // - user_tours (via FK)
        // - cookbooks (via FK)
        // - saved_recipes (via FK)
        // - etc.
        const { error: deleteError } = await supabase
          .from('users')
          .delete()
          .eq('id', user.id);

        if (deleteError) {
          console.error(`[AccountDeletion] ❌ Error deleting user ${user.email}:`, deleteError.message);
          errorCount++;
          continue;
        }

        console.log(`[AccountDeletion] ✅ Successfully deleted account: ${user.email}`);
        successCount++;

      } catch (userError) {
        console.error(`[AccountDeletion] ❌ Error processing user ${user.email}:`, userError);
        errorCount++;
      }
    }

    console.log('[AccountDeletion] Processing complete');
    console.log(`[AccountDeletion]   ✅ Successfully deleted: ${successCount}`);
    console.log(`[AccountDeletion]   ❌ Failed: ${errorCount}`);

  } catch (error) {
    console.error('[AccountDeletion] Error in account deletion scheduler:', error);
  }
}

/**
 * Start the account deletion scheduler
 * Runs daily at 2:00 AM (server time)
 */
function startScheduler() {
  // Run daily at 2:00 AM (server time)
  // Cron format: minute hour day month weekday
  const cronSchedule = '0 2 * * *'; // 2:00 AM every day

  console.log('[AccountDeletion] Starting account deletion scheduler (runs daily at 2:00 AM)');

  cron.schedule(cronSchedule, async () => {
    console.log('[AccountDeletion] Scheduled task running...');
    await processAccountDeletions();
  });

  // Also run immediately on startup for testing (development only)
  if (process.env.NODE_ENV !== 'production') {
    console.log('[AccountDeletion] Development mode - scheduler initialized without immediate run');
    // Uncomment the line below to run on startup in development
    // processAccountDeletions();
  }

  console.log('[AccountDeletion] Scheduler initialized successfully');
}

/**
 * Manual trigger for testing
 */
async function runNow() {
  console.log('[AccountDeletion] Manual trigger requested');
  await processAccountDeletions();
}

module.exports = {
  startScheduler,
  processAccountDeletions,
  runNow
};
