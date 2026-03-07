/**
 * Script to grant permanent premium access to a user
 * Usage: node grant_permanent_premium.js <email>
 */

require('dotenv').config();
const { getServiceClient } = require('./config/supabase');

async function grantPermanentPremium(email) {
  try {
    const supabase = getServiceClient();

    console.log('\n=== Grant Permanent Premium Access ===');
    console.log(`Email: ${email}\n`);

    // Check if user exists
    const { data: user, error: userError } = await supabase
      .from('users')
      .select('id, email, tier, is_grandfathered')
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

    console.log('📋 Current Status:');
    console.log(`  Email: ${user.email}`);
    console.log(`  Tier: ${user.tier || 'free'}`);
    console.log(`  Grandfathered: ${user.is_grandfathered || false}`);

    // Update user to grandfathered (permanent premium)
    const { error: updateError } = await supabase
      .from('users')
      .update({
        tier: 'grandfathered',
        is_grandfathered: true,
        updated_at: new Date().toISOString()
      })
      .eq('id', user.id);

    if (updateError) {
      console.error('\n❌ Error updating user:', updateError.message);
      return;
    }

    // Verify the update
    const { data: updatedUser, error: verifyError } = await supabase
      .from('users')
      .select('email, tier, is_grandfathered, updated_at')
      .eq('id', user.id)
      .single();

    if (verifyError) {
      console.error('\n❌ Error verifying update:', verifyError.message);
      return;
    }

    console.log('\n✅ Successfully Updated!');
    console.log('\n📋 New Status:');
    console.log(`  Email: ${updatedUser.email}`);
    console.log(`  Tier: ${updatedUser.tier}`);
    console.log(`  Grandfathered: ${updatedUser.is_grandfathered}`);
    console.log(`  Updated At: ${updatedUser.updated_at}`);

    if (updatedUser.tier === 'grandfathered' && updatedUser.is_grandfathered) {
      console.log('\n🎉 User now has PERMANENT PREMIUM ACCESS!');
      console.log('   This user will have premium features forever without needing a subscription.');
    } else {
      console.log('\n⚠️  Something went wrong - tier not properly updated');
    }

    console.log('\n');

  } catch (error) {
    console.error('❌ Fatal error:', error);
  }
}

// Get email from command line args
const email = process.argv[2] || 'testa@gmail.com';

console.log(`Granting permanent premium access to: ${email}`);

grantPermanentPremium(email).then(() => {
  process.exit(0);
}).catch(error => {
  console.error('Script failed:', error);
  process.exit(1);
});
