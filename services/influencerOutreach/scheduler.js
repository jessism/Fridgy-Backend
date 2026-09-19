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
const replyScan = require('./replyScan');
const sheetMirror = require('./sheetMirror');
const mailer = require('./mailer');

const TAG = '[Outreach]';

async function todaySnapshot() {
  const sb = getServiceClient();
  const counts = {};
  const { data: rows } = await sb.from('influencers').select('status');
  for (const r of rows || []) counts[r.status] = (counts[r.status] || 0) + 1;
  const { data: touches } = await sb.from('influencer_touches')
    .select('step, channel, influencers!inner(handle, status)')
    .is('sent_at', null);
  const open = (touches || []).filter((t) => ['dm_needed', 'contacted', 'followup_needed'].includes(t.influencers.status));
  const since = new Date(Date.now() - 86400000).toISOString();
  const { data: replies } = await sb.from('influencers').select('handle').eq('status', 'replied').gte('replied_at', since);
  return {
    counts,
    dmsDue: open.filter((t) => t.channel === 'dm'),
    emailsDue: open.filter((t) => t.channel === 'email'),
    repliesToday: replies || [],
  };
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
    `Emails drafted, waiting for you to send: ${s.emailsDue.length}`,
    `Contacted, waiting: ${c.contacted || 0}`,
    `Replied in the last 24h: ${s.repliesToday.length}` + (s.repliesToday.length ? ` (${s.repliesToday.map((r) => '@' + r.handle).join(', ')})` : ''),
    ``,
    `Open the dashboard: ${config.dashboardUrl}`,
  ];
  await mailer.sendInternal({
    subject: `Trackabite outreach tonight: ${s.dmsDue.length} DMs, ${s.emailsDue.length} emails, ${c.pending_approval || 0} pending`,
    text: lines.join('\n'),
  });
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
  cron.schedule(config.cron.evening, safe('follow-ups', runFollowups), tz);
  cron.schedule(config.cron.digest, safe('digest', sendDigest), tz);
  cron.schedule(config.cron.imap, safe('reply scan', replyScan.scan), tz);
  cron.schedule(config.cron.mirror, safe('sheet mirror', sheetMirror.mirror), tz);
  console.log(`${TAG} scheduler running (${config.TIMEZONE}): evening ${config.cron.evening}, digest ${config.cron.digest}, imap ${config.cron.imap}, mirror ${config.cron.mirror}; email ${mailer.isEnabled() ? 'ENABLED' : 'disabled'}`);
}

module.exports = { start, runFollowups, sendDigest, scan: replyScan.scan, mirror: sheetMirror.mirror };
