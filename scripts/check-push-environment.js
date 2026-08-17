// Diagnostic: is production push actually reaching App Store users?
//
// Why this exists: ios/Trackabite/Trackabite.entitlements hardcodes
// aps-environment=development. EAS is expected to normalize that against the
// distribution provisioning profile, but that's a build-service implementation
// detail, not a contract. If it did NOT normalize, every push sent since
// Build 30 shipped has silently gone nowhere.
//
// This asks Expo's push service directly. A DeviceNotRegistered error across
// all production tokens is the signature of an environment mismatch.
//
// Run from the Backend directory:
//   node scripts/check-push-environment.js               # inspect tokens only
//   node scripts/check-push-environment.js --send        # send to every token
//   node scripts/check-push-environment.js --send --device="iPhone 17 Pro"
//        restrict the send to matching device names, so a diagnostic never
//        lands on a real user's phone
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { getServiceClient } = require('../config/supabase');

const SEND = process.argv.includes('--send');
const DEVICE_FILTER = (process.argv.find((a) => a.startsWith('--device=')) || '')
  .replace('--device=', '')
  .toLowerCase();

async function main() {
  const supabase = getServiceClient();

  const { data: tokens, error } = await supabase
    .from('mobile_push_tokens')
    .select('id, user_id, expo_token, device_name, updated_at')
    .order('updated_at', { ascending: false })
    .limit(20);

  if (error) throw error;

  if (!tokens?.length) {
    console.log('No mobile push tokens registered — nothing to test.');
    return;
  }

  console.log(`Found ${tokens.length} recent mobile push token(s):\n`);
  for (const t of tokens) {
    console.log(`  ${t.expo_token.slice(0, 28)}…  ${t.device_name || 'unknown device'}  (updated ${t.updated_at?.slice(0, 10)})`);
  }

  // Expo's /push/getReceipts needs ticket ids from a prior send, so the only
  // way to learn the delivery outcome is to send and then read the receipt.
  if (!SEND) {
    console.log('\nRe-run with --send to deliver a real test notification and read its receipt.');
    console.log('That is what actually proves whether production push works.');
    return;
  }

  const targets = DEVICE_FILTER
    ? tokens.filter((t) => (t.device_name || '').toLowerCase().includes(DEVICE_FILTER))
    : tokens;

  if (DEVICE_FILTER) {
    console.log(`\nDevice filter "${DEVICE_FILTER}" → ${targets.length}/${tokens.length} token(s) targeted.`);
  }
  if (!targets.length) {
    console.log('No tokens matched the device filter — nothing sent.');
    return;
  }

  const messages = targets.map((t) => ({
    to: t.expo_token,
    title: 'Trackabite push check',
    body: 'Diagnostic only — safe to dismiss.',
    data: { diagnostic: true },
  }));

  console.log(`\nSending ${messages.length} test push(es) via Expo…`);
  const sendRes = await fetch('https://exp.host/--/api/v2/push/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(messages),
  });
  const sendJson = await sendRes.json();
  const tickets = sendJson?.data || [];

  const ticketIds = [];
  tickets.forEach((ticket, i) => {
    const label = targets[i]?.device_name || targets[i]?.expo_token?.slice(0, 20);
    if (ticket.status === 'error') {
      console.log(`  ✗ ${label}: ${ticket.message} ${ticket.details?.error ? `(${ticket.details.error})` : ''}`);
    } else {
      console.log(`  · ${label}: accepted (ticket ${ticket.id})`);
      ticketIds.push(ticket.id);
    }
  });

  if (!ticketIds.length) {
    console.log('\nNo tickets accepted — see errors above.');
    return;
  }

  console.log('\nWaiting 12s for delivery receipts…');
  await new Promise((r) => setTimeout(r, 12000));

  const recRes = await fetch('https://exp.host/--/api/v2/push/getReceipts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ ids: ticketIds }),
  });
  const recJson = await recRes.json();
  const receipts = recJson?.data || {};

  let ok = 0;
  let deviceNotRegistered = 0;
  for (const [id, r] of Object.entries(receipts)) {
    if (r.status === 'ok') {
      ok++;
    } else {
      const err = r.details?.error;
      if (err === 'DeviceNotRegistered') deviceNotRegistered++;
      console.log(`  ✗ ${id}: ${r.status} — ${r.message || ''} ${err ? `(${err})` : ''}`);
    }
  }

  console.log(`\nDelivered: ${ok}/${ticketIds.length}`);
  console.log('\nVerdict:');
  if (ok > 0) {
    console.log('  ✅ Production push WORKS. EAS normalized aps-environment against the');
    console.log('     distribution profile. §2.2 stays a low-priority hardening item.');
  } else if (deviceNotRegistered === ticketIds.length) {
    console.log('  ⚠️  Every token returned DeviceNotRegistered. That is the signature of an');
    console.log('     APNs environment mismatch — production push is likely DEAD since Build 30.');
    console.log('     §2.2 (per-configuration entitlements) jumps the queue for Build 31.');
  } else {
    console.log('  ❓ Mixed/unclear results — see the per-receipt errors above.');
    console.log('     Stale tokens from deleted apps also return DeviceNotRegistered, so');
    console.log('     judge by whether ANY active device received it.');
  }
}

main().catch((e) => {
  console.error('Failed:', e.message);
  process.exit(1);
});
