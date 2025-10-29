/**
 * Fix Tier Sync Issue
 * Updates users.tier to match subscriptions.tier for users with active subscriptions
 */

require('dotenv').config();
const { getServiceClient } = require('./config/supabase');

async function fixTierSync() {
  try {
    const supabase = getServiceClient();

    console.log('\n=== Tier Sync Fix ===\n');

    // Find all users with active/trialing subscriptions but free tier
    const { data: mismatchedUsers, error: fetchError } = await supabase
      .from('subscriptions')
      .select(`
        user_id,
        tier,
        status,
        stripe_subscription_id,
        users!inner (
          id,
          email,
          tier
        )
      `)
      .in('status', ['active', 'trialing'])
      .neq('users.tier', 'premium')
      .neq('users.tier', 'grandfathered');

    if (fetchError) {
      console.error('❌ Error fetching mismatched users:', fetchError);
      return;
    }

    if (!mismatchedUsers || mismatchedUsers.length === 0) {
      console.log('✅ No tier mismatches found. All users are in sync!');
      return;
    }

    console.log(`🔍 Found ${mismatchedUsers.length} user(s) with tier mismatch:\n`);

    for (const record of mismatchedUsers) {
      const email = record.users?.email || 'unknown';
      const userId = record.user_id;
      const currentTier = record.users?.tier || 'free';
      const correctTier = record.tier;
      const status = record.status;

      console.log(`📋 User: ${email}`);
      console.log(`   User ID: ${userId}`);
      console.log(`   Subscription Status: ${status}`);
      console.log(`   Current Tier (users): ${currentTier}`);
      console.log(`   Correct Tier (subscriptions): ${correctTier}`);
      console.log(`   Stripe Sub ID: ${record.stripe_subscription_id}`);

      // Update the user's tier
      const { error: updateError } = await supabase
        .from('users')
        .update({ tier: correctTier })
        .eq('id', userId);

      if (updateError) {
        console.log(`   ❌ Failed to update: ${updateError.message}\n`);
      } else {
        console.log(`   ✅ Updated tier to "${correctTier}"\n`);
      }
    }

    console.log('=== Fix Complete ===\n');

  } catch (error) {
    console.error('❌ Fatal error:', error);
  }
}

fixTierSync().then(() => {
  process.exit(0);
}).catch(error => {
  console.error('Script failed:', error);
  process.exit(1);
});
