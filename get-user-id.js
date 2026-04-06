/**
 * Get user ID by email
 * Usage: node get-user-id.js <email>
 */

require('dotenv').config();
const { getServiceClient } = require('./config/supabase');

const email = process.argv[2];

if (!email) {
  console.error('❌ Error: Email required');
  console.log('Usage: node get-user-id.js <email>');
  process.exit(1);
}

async function main() {
  try {
    const supabase = getServiceClient();

    const { data, error } = await supabase
      .from('users')
      .select('id, email, tier')
      .eq('email', email)
      .single();

    if (error) {
      console.error('❌ Error:', error.message);
      process.exit(1);
    }

    if (!data) {
      console.error('❌ User not found');
      process.exit(1);
    }

    console.log('✅ Found user:');
    console.log('  Email:', data.email);
    console.log('  ID:', data.id);
    console.log('  Tier:', data.tier);
    console.log('\nTo sync usage counts, run:');
    console.log(`  node sync-user-usage.js ${data.id}`);

    process.exit(0);
  } catch (error) {
    console.error('❌ Error:', error.message);
    process.exit(1);
  }
}

main();
