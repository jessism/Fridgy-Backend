/**
 * Cron jobs for influencer outreach (all in America/Los_Angeles):
 *   evening  – follow-up emails, no_response sweep, retry of failed emails
 *   digest   – "tonight" email to Jessie on session days
 *   imap     – reply / bounce / STOP scan
 *   mirror   – Google Sheet archive
 * Each job is independent and logs its own summary; a failure in one never
 * stops the others.
 */
const cron = require('node-cron');
const { getServiceClient } = require('../../config/supabase');
const config = require('./config');
const { runFollowups } = require('./stateMachine');
const { retryEmailTouch } = require('./sendTouch');
const replyScan = require('./replyScan');
const sheetMirror = require('./sheetMirror');
const mailer = require('./mailer');

const TAG = '[Outreach]';

async function retryFailedEmails() {
  const sb = getServiceClient();
  const { data: failed, error } = await sb
    .from('influencer_touches')
    .select('*, influencers(*)')
    .eq('channel', 'email')
    .is('sent_at', null)
    .not('error', 'is', null)
    .limit(20);
  if (error) throw error;
  let ok = 0;
  for (const t of failed || []) {
    const inf = t.influencers;
    if (!inf || !inf.email || ['rejected', 'opted_out', 'bounced', 'replied', 'signed', 'declined'].includes(inf.status)) continue;
    try { await retryEmailTouch(t, inf); ok += 1; } catch (e) { /* stays errored, visible on the dashboard */ }
  }
  return { failed: (failed || []).length, resent: ok };
}

async function todaySnapshot() {
  const sb = getServiceClient();
  const counts = {};
  const { data: rows } = await sb.from('influencers').select('status');
  for (const r of rows || []) counts[r.status] = (counts[r.status] || 0) + 1;
  const { data: dms } = await sb.from('influencer_touches').select('step, influencers!inner(handle, status)')
    .eq('channel', 'dm').is('sent_at', null);
  const since = new Date(Date.now() - 86400000).toISOString();
  const { data: replies } = await sb.from('influencers').select('handle').eq('status', 'replied').gte('replied_at', since);
  return { counts, dmsDue: dms || [], repliesToday: replies || [] };
}

async function sendDigest() {
  const s = await todaySnapshot();
  const c = s.counts;
  const lines = [
    `Tonight's outreach session`,
    ``,
    `Pending approval: ${c.pending_approval || 0}`,
    `Warm-up needed: ${c.warmup_needed || 0}`,
    `DMs to send: ${s.dmsDue.length}` + (s.dmsDue.length ? ` (${s.dmsDue.map((t) => `@${t.influencers.handle} #${t.step}`).join(', ')})` : ''),
    `Contacted, waiting: ${c.contacted || 0}`,
    `Replied in the last 24h: ${s.repliesToday.length}` + (s.repliesToday.length ? ` (${s.repliesToday.map((r) => '@' + r.handle).join(', ')})` : ''),
    ``,
    `Open the dashboard: ${config.dashboardUrl}`,
  ];
  await mailer.sendInternal({ subject: `Trackabite outreach tonight: ${s.dmsDue.length} DMs, ${c.pending_approval || 0} pending`, text: lines.join('\n') });
}

function safe(name, fn) {
  return async () => {
    try {
      const out = await fn();
      console.log(`${TAG} ${name}:`, JSON.stringify(out ?? {}));
    } catch (e) {
      console.error(`${TAG} ${name} failed:`, e.message);
    }
  };
}

function start() {
  const tz = { timezone: config.TIMEZONE };
  cron.schedule(config.cron.evening, safe('follow-ups', async () => ({
    followups: await runFollowups(),
    retries: await retryFailedEmails(),
  })), tz);
  cron.schedule(config.cron.digest, safe('digest', sendDigest), tz);
  cron.schedule(config.cron.imap, safe('reply scan', replyScan.scan), tz);
  cron.schedule(config.cron.mirror, safe('sheet mirror', sheetMirror.mirror), tz);
  console.log(`${TAG} scheduler running (${config.TIMEZONE}): evening ${config.cron.evening}, digest ${config.cron.digest}, imap ${config.cron.imap}, mirror ${config.cron.mirror}; email ${mailer.isEnabled() ? 'ENABLED' : 'disabled'}`);
}

module.exports = { start, runFollowups, retryFailedEmails, sendDigest, scan: replyScan.scan, mirror: sheetMirror.mirror };
