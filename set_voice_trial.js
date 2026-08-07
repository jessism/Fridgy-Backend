/**
 * Inspect or set a user's one-time premium-voice trial state.
 *
 * The server can only ever START a trial (voiceAccessService guards its
 * update with .is('voice_trial_started_at', null)), so testing the trial
 * lifecycle needs this service-role script to move the clock by hand.
 *
 * Usage: node set_voice_trial.js <email> [action]
 *   status  (default)  read-only: tier + trial state + minutes remaining
 *   reset              voice_trial_started_at = NULL       -> stage 'meet'
 *   start              = now()                             -> stage 'more'
 *   expire             = now() - 3h                        -> stage 'upgrade'
 *   ending             = ~2 min of trial left, for the live-expiry test
 *
 * WARNING: this writes to the PRODUCTION Supabase project.
 */

require('dotenv').config();
const { getServiceClient } = require('./config/supabase');

// Keep in sync with services/voiceAccessService.js
const TRIAL_DURATION_MS = 1 * 60 * 60 * 1000;

const ACTIONS = {
  status: null,
  reset: () => null,
  start: () => new Date().toISOString(),
  expire: () => new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
  ending: () => new Date(Date.now() - (TRIAL_DURATION_MS - 2 * 60 * 1000)).toISOString(),
};

// Mirror of trialState() in services/voiceAccessService.js - keep identical
// so this script can never disagree with what the server will decide.
function trialState(trialStartedAt) {
  if (trialStartedAt === undefined) {
    return { trialAvailable: false, trialActive: false, trialUsed: true, trialActiveUntil: null };
  }
  if (trialStartedAt === null) {
    return { trialAvailable: true, trialActive: false, trialUsed: false, trialActiveUntil: null };
  }
  const until = trialStartedAt.getTime() + TRIAL_DURATION_MS;
  const active = Date.now() < until;
  return {
    trialAvailable: false,
    trialActive: active,
    trialUsed: true,
    trialActiveUntil: new Date(until).toISOString(),
  };
}

function describe(row) {
  const startedAt = row.voice_trial_started_at ? new Date(row.voice_trial_started_at) : null;
  const state = trialState(startedAt);

  console.log(`  Tier:                   ${row.tier || 'free'}`);
  console.log(`  voice_trial_started_at: ${row.voice_trial_started_at ?? 'NULL'}`);
  console.log(`  trialAvailable:         ${state.trialAvailable}`);
  console.log(`  trialActive:            ${state.trialActive}`);
  console.log(`  trialUsed:              ${state.trialUsed}`);
  if (state.trialActive) {
    const minsLeft = Math.ceil((Date.parse(state.trialActiveUntil) - Date.now()) / 60000);
    console.log(`  Remaining:              ~${minsLeft} min (until ${state.trialActiveUntil})`);
  }

  const stage = state.trialActive
    ? "'more'    - trial running: voices unlocked, countdown showing"
    : state.trialAvailable
      ? "'meet'    - trial untouched: voices locked, intro banner"
      : "'upgrade' - trial spent: voices locked, trial-ended banner";
  console.log(`  Expected banner stage:  ${stage}`);
}

async function main() {
  const email = process.argv[2];
  const action = process.argv[3] || 'status';

  if (!email || !email.includes('@')) {
    console.error('Usage: node set_voice_trial.js <email> [status|reset|start|expire|ending]');
    process.exit(1);
  }
  if (!(action in ACTIONS)) {
    console.error(`Unknown action "${action}". Valid: ${Object.keys(ACTIONS).join(', ')}`);
    process.exit(1);
  }

  const supabase = getServiceClient();

  console.log('\n=== Voice Trial State ===');
  console.log(`Email:  ${email}`);
  console.log(`Action: ${action}`);
  console.log('⚠️  This talks to the PRODUCTION Supabase project.\n');

  const { data: user, error } = await supabase
    .from('users')
    .select('id, email, tier, voice_trial_started_at')
    .eq('email', email)
    .single();

  if (error) {
    if (/voice_trial_started_at/.test(error.message)) {
      console.error('❌ Column users.voice_trial_started_at does not exist.');
      console.error('   Migration 075_add_voice_trial_column.sql has NOT been applied.');
      console.error('   Apply it via the Supabase dashboard SQL editor, then re-run.');
    } else {
      console.error('❌ Lookup failed:', error.message);
    }
    process.exit(1);
  }
  if (!user) {
    console.error('❌ User not found');
    process.exit(1);
  }

  console.log('📋 Current state:');
  describe(user);

  if (action === 'status') {
    console.log('');
    return;
  }

  const newValue = ACTIONS[action]();
  const { error: updateError } = await supabase
    .from('users')
    .update({ voice_trial_started_at: newValue })
    .eq('id', user.id);

  if (updateError) {
    console.error('\n❌ Update failed:', updateError.message);
    process.exit(1);
  }

  const { data: updated, error: verifyError } = await supabase
    .from('users')
    .select('id, email, tier, voice_trial_started_at')
    .eq('id', user.id)
    .single();

  if (verifyError) {
    console.error('\n❌ Verify read failed:', verifyError.message);
    process.exit(1);
  }

  console.log('\n✅ Updated. New state:');
  describe(updated);
  console.log('\n⏳ Railway caches access for up to 5 min; wait or restart the service before testing.\n');
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Script failed:', err);
    process.exit(1);
  });
