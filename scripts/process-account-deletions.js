/**
 * Account Deletion Processor
 *
 * This script should be run daily via cron job to process pending account deletions.
 * It finds accounts that have passed their 30-day grace period and permanently deletes them.
 *
 * Usage: node scripts/process-account-deletions.js
 * Recommended cron: 0 2 * * * (runs daily at 2 AM)
 */

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

async function processAccountDeletions() {
  try {
    console.log('[Account Deletion Cron] Starting account deletion processing...');

    const now = new Date().toISOString();

    // Find all accounts scheduled for deletion that have passed their grace period
    const { data: accountsToDelete, error: fetchError } = await supabase
      .from('users')
      .select('id, email, first_name, deletion_requested_at, deletion_scheduled_for')
      .eq('deletion_status', 'pending')
      .lte('deletion_scheduled_for', now);

    if (fetchError) {
      console.error('[Account Deletion Cron] Error fetching accounts:', fetchError);
      throw fetchError;
    }

    if (!accountsToDelete || accountsToDelete.length === 0) {
      console.log('[Account Deletion Cron] No accounts to delete at this time');
      return;
    }

    console.log(`[Account Deletion Cron] Found ${accountsToDelete.length} accounts to delete`);

    // Process each account
    for (const user of accountsToDelete) {
      try {
        console.log(`[Account Deletion Cron] Deleting account: ${user.email} (ID: ${user.id})`);

        // Delete user - CASCADE will handle related data:
        // - subscriptions (via FK)
        // - usage_limits (via FK)
        // - recipes (via FK)
        // - fridge_items (via FK)
        // - meal_plans (via FK)
        // - shopping_lists (via FK)
        // - user_tours (via FK)
        // - etc.
        const { error: deleteError } = await supabase
          .from('users')
          .delete()
          .eq('id', user.id);

        if (deleteError) {
          console.error(`[Account Deletion Cron] Error deleting user ${user.email}:`, deleteError);
          // Continue with other accounts even if one fails
          continue;
        }

        console.log(`[Account Deletion Cron] Successfully deleted account: ${user.email}`);

      } catch (userError) {
        console.error(`[Account Deletion Cron] Error processing user ${user.email}:`, userError);
        // Continue with other accounts
      }
    }

    console.log('[Account Deletion Cron] Account deletion processing completed');

  } catch (error) {
    console.error('[Account Deletion Cron] Fatal error:', error);
    process.exit(1);
  }
}

// Run if called directly
if (require.main === module) {
  processAccountDeletions()
    .then(() => {
      console.log('[Account Deletion Cron] Process completed successfully');
      process.exit(0);
    })
    .catch((error) => {
      console.error('[Account Deletion Cron] Process failed:', error);
      process.exit(1);
    });
}

module.exports = { processAccountDeletions };
