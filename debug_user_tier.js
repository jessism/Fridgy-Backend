/**
 * Debug script to check user tier and subscription status
 * Usage: node debug_user_tier.js <email>
 */

require('dotenv').config();
const { getServiceClient } = require('./config/supabase');

async function debugUserTier(email) {
  try {
    const supabase = getServiceClient();

    console.log('\n=== User Tier Debug ===');
    console.log(`Checking user: ${email}\n`);

    // Get user data
    const { data: user, error: userError } = await supabase
      .from('users')
      .select('id, email, tier, is_grandfathered, created_at')
      .eq('email', email)
      .single();

    if (userError) {
      console.error('❌ Error fetching user:', userError.message);
      return;
    }

    if (!user) {
      console.error('❌ User not found');
      return;
    }

    console.log('📋 User Info:');
    console.log(`  ID: ${user.id}`);
    console.log(`  Email: ${user.email}`);
    console.log(`  Tier: ${user.tier || 'null (defaults to free)'}`);
    console.log(`  Grandfathered: ${user.is_grandfathered || false}`);
    console.log(`  Created: ${user.created_at}`);

    // Get subscription data
    const { data: subscription, error: subError } = await supabase
      .from('subscriptions')
      .select('*')
      .eq('user_id', user.id)
      .single();

    if (subError && subError.code !== 'PGRST116') {
      console.error('\n❌ Error fetching subscription:', subError.message);
    } else if (!subscription) {
      console.log('\n⚠️  No subscription record found');
    } else {
      console.log('\n💳 Subscription Info:');
      console.log(`  Stripe Subscription ID: ${subscription.stripe_subscription_id || 'null'}`);
      console.log(`  Stripe Customer ID: ${subscription.stripe_customer_id || 'null'}`);
      console.log(`  Tier: ${subscription.tier || 'null'}`);
      console.log(`  Status: ${subscription.status || 'null'}`);
      console.log(`  Trial End: ${subscription.trial_end || 'null'}`);
      console.log(`  Cancel at Period End: ${subscription.cancel_at_period_end || false}`);
      console.log(`  Created: ${subscription.created_at}`);
      console.log(`  Updated: ${subscription.updated_at}`);
    }

    // Get usage limits
    const { data: usage, error: usageError } = await supabase
      .from('usage_limits')
      .select('*')
      .eq('user_id', user.id)
      .single();

    if (usageError && usageError.code !== 'PGRST116') {
      console.error('\n❌ Error fetching usage limits:', usageError.message);
    } else if (!usage) {
      console.log('\n⚠️  No usage limits record found');
    } else {
      console.log('\n📊 Usage Stats:');
      console.log(`  Grocery Items: ${usage.grocery_items_count || 0}`);
      console.log(`  Imported Recipes: ${usage.imported_recipes_count || 0}`);
      console.log(`  Uploaded Recipes: ${usage.uploaded_recipes_count || 0}`);
      console.log(`  Meal Logs: ${usage.meal_logs_count || 0}`);
      console.log(`  Owned Shopping Lists: ${usage.owned_shopping_lists_count || 0}`);
      console.log(`  Joined Shopping Lists: ${usage.joined_shopping_lists_count || 0}`);
    }

    // Diagnosis
    console.log('\n🔍 Diagnosis:');

    if (!user.tier || user.tier === 'free') {
      if (subscription && (subscription.status === 'active' || subscription.status === 'trialing')) {
        console.log('  🔴 ISSUE FOUND: User has active subscription but tier is "free"!');
        console.log('  💡 Fix: Update users.tier to "premium"');
      } else {
        console.log('  ✅ User is correctly on free tier (no active subscription)');
      }
    } else if (user.tier === 'premium' || user.tier === 'grandfathered') {
      console.log('  ✅ User tier is correctly set to premium/grandfathered');
      if (!subscription || (subscription.status !== 'active' && subscription.status !== 'trialing')) {
        console.log('  ⚠️  Warning: Premium tier but no active subscription record');
      }
    }

    // Check if hitting limits
    if (usage) {
      const limits = {
        free: { grocery_items: 20 },
        premium: { grocery_items: Infinity },
        grandfathered: { grocery_items: Infinity }
      };

      const userTier = user.tier || 'free';
      const limit = limits[userTier]?.grocery_items || 20;
      const current = usage.grocery_items_count || 0;

      console.log(`\n📦 Grocery Items Check:`);
      console.log(`  Current: ${current}`);
      console.log(`  Limit: ${limit}`);
      console.log(`  Allowed: ${current < limit ? '✅ YES' : '❌ NO (LIMIT EXCEEDED)'}`);

      if (current >= limit && subscription?.status === 'active') {
        console.log(`  🔴 BUG: User is hitting free tier limit despite having active subscription!`);
      }
    }

    console.log('\n');

  } catch (error) {
    console.error('❌ Fatal error:', error);
  }
}

// Get email from command line args
const email = process.argv[2];

if (!email) {
  console.error('Usage: node debug_user_tier.js <email>');
  console.error('Example: node debug_user_tier.js test@example.com');
  process.exit(1);
}

debugUserTier(email).then(() => {
  process.exit(0);
}).catch(error => {
  console.error('Script failed:', error);
  process.exit(1);
});
