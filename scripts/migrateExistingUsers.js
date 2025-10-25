/**
 * Migration Script: Grandfather Existing Users
 * Grants lifetime premium access to all users created before the payment system launch
 *
 * IMPORTANT: Run this ONCE before deploying the payment system to production
 *
 * Usage: node Backend/scripts/migrateExistingUsers.js
 */

require('dotenv').config();
const db = require('../config/database');

// Set this to the date you're launching the payment system
// All users created BEFORE this date will be grandfathered
const LAUNCH_DATE = '2025-10-22'; // Update this to your actual launch date

async function migrateExistingUsers() {
  console.log('========================================');
  console.log('🚀 Starting Existing User Migration');
  console.log('========================================');
  console.log('Launch Date:', LAUNCH_DATE);
  console.log('All users created before this date will be grandfathered\n');

  try {
    // Get all users created before launch date
    const existingUsers = await db.query(`
      SELECT id, email, first_name, created_at
      FROM users
      WHERE created_at < $1
      ORDER BY created_at DESC
    `, [LAUNCH_DATE]);

    const totalUsers = existingUsers.rows.length;

    console.log(`📊 Found ${totalUsers} existing users to grandfather\n`);

    if (totalUsers === 0) {
      console.log('✅ No existing users found. Migration complete!');
      process.exit(0);
    }

    // Confirm before proceeding
    console.log('Users to be migrated:');
    existingUsers.rows.forEach((user, index) => {
      console.log(`  ${index + 1}. ${user.email} (created: ${new Date(user.created_at).toLocaleDateString()})`);
    });

    console.log('\n⚠️  This will grant lifetime premium access to these users.');
    console.log('Press Ctrl+C to cancel, or wait 5 seconds to proceed...\n');

    // Wait 5 seconds before proceeding
    await new Promise(resolve => setTimeout(resolve, 5000));

    let successCount = 0;
    let failCount = 0;

    // Migrate each user
    for (const user of existingUsers.rows) {
      try {
        // Update user tier to grandfathered
        await db.query(`
          UPDATE users
          SET tier = 'grandfathered', is_grandfathered = true
          WHERE id = $1
        `, [user.id]);

        // Ensure usage_limits entry exists
        await db.query(`
          INSERT INTO usage_limits (user_id)
          VALUES ($1)
          ON CONFLICT (user_id) DO NOTHING
        `, [user.id]);

        console.log(`✅ Migrated: ${user.email}`);
        successCount++;
      } catch (error) {
        console.error(`❌ Failed to migrate ${user.email}:`, error.message);
        failCount++;
      }
    }

    console.log('\n========================================');
    console.log('📈 Migration Summary');
    console.log('========================================');
    console.log(`Total users: ${totalUsers}`);
    console.log(`✅ Successfully migrated: ${successCount}`);
    console.log(`❌ Failed: ${failCount}`);

    // Verify migration
    const verifyResult = await db.query(`
      SELECT COUNT(*) as count
      FROM users
      WHERE is_grandfathered = true
    `);

    console.log(`\n🔍 Verification: ${verifyResult.rows[0].count} users are now grandfathered`);

    console.log('\n✅ Migration complete!');
    process.exit(0);
  } catch (error) {
    console.error('\n❌ Migration failed:', error);
    process.exit(1);
  }
}

// Run migration
migrateExistingUsers();
