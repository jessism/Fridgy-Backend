/**
 * Utility script to sync usage counts for a specific user
 * This recalculates counts from actual database records
 *
 * Usage: node sync-user-usage.js <userId>
 */

const { syncUsageCounts } = require('./services/usageService');

const userId = process.argv[2];

if (!userId) {
  console.error('❌ Error: User ID required');
  console.log('Usage: node sync-user-usage.js <userId>');
  process.exit(1);
}

async function main() {
  try {
    console.log(`🔄 Syncing usage counts for user: ${userId}`);

    const result = await syncUsageCounts(userId);

    console.log('✅ Usage counts synced successfully:');
    console.log(JSON.stringify(result, null, 2));

    process.exit(0);
  } catch (error) {
    console.error('❌ Error syncing usage counts:', error);
    process.exit(1);
  }
}

main();
