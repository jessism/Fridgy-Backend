/**
 * Email alerts for Reddit opportunities, both flavors:
 *   sendInstantAlerts — one email per high scorer, right after scoring
 *   sendDigest        — one morning email with everything else worth a look
 *
 * Both go through the outreach mailer's sendInternal (Gmail API transport,
 * NOTIFY_EMAIL recipient, not gated by OUTREACH_EMAIL_ENABLED).
 */
const { getServiceClient } = require('../../config/supabase');
const mailer = require('../influencerOutreach/mailer');
const config = require('./config');

const line = (o) =>
  `[${o.score}] r/${o.subreddit} — ${o.title || '(no title captured)'}\n${o.reddit_url}`;

async function sendInstantAlerts() {
  const sb = getServiceClient();
  const { data: rows, error } = await sb
    .from('reddit_opportunities')
    .select('*')
    .eq('status', 'new')
    .gte('score', config.alertScore)
    .is('alerted_at', null)
    .order('score', { ascending: false })
    .limit(config.maxAlertsPerRun);
  if (error) throw error;

  let sent = 0;
  for (const o of rows || []) {
    const text = [
      line(o),
      '',
      `Matched keyword: ${o.keyword || '—'} · ${o.kind || 'post'}${o.excerpt ? `\nExcerpt: ${o.excerpt}` : ''}`,
      `Why: ${o.score_reason || '—'}`,
      '',
      o.suggested_reply ? `Suggested reply (edit before posting):\n\n${o.suggested_reply}` : 'No reply drafted — use the console.',
      '',
      `Mark it handled: ${config.dashboardUrl}`,
    ].join('\n');

    const id = await mailer.sendInternal({
      subject: `Reddit opportunity (${o.score}): ${(o.title || o.reddit_url).slice(0, 90)}`,
      text,
    });
    // Mail not configured → sendInternal logs and returns null; leave the row
    // un-alerted so it goes out once mail works instead of silently dropping.
    if (!id) break;
    const { error: e2 } = await sb
      .from('reddit_opportunities')
      .update({ alerted_at: new Date().toISOString() })
      .eq('id', o.id);
    if (e2) throw e2;
    sent += 1;
  }
  return { eligible: (rows || []).length, sent };
}

/** Mid-score finds since the last digest, one ranked email. Skips when empty. */
async function sendDigest() {
  const sb = getServiceClient();
  const { data: rows, error } = await sb
    .from('reddit_opportunities')
    .select('*')
    .eq('status', 'new')
    .gte('score', config.keepScore)
    .is('alerted_at', null)
    .is('digested_at', null)
    .order('score', { ascending: false })
    .limit(50);
  if (error) throw error;
  if (!rows?.length) return { items: 0, skipped: 'nothing to digest' };

  const text = [
    `${rows.length} Reddit ${rows.length === 1 ? 'opportunity' : 'opportunities'} worth a look (high scorers were already emailed on the spot):`,
    '',
    ...rows.map((o) => `${line(o)}\n   ${o.score_reason || ''}`.trimEnd()),
    '',
    `Reply templates + mark handled: ${config.dashboardUrl}`,
  ].join('\n');

  const id = await mailer.sendInternal({
    subject: `Reddit digest: ${rows.length} ${rows.length === 1 ? 'opportunity' : 'opportunities'}`,
    text,
  });
  if (!id) return { items: rows.length, skipped: 'mail not configured' };

  const { error: e2 } = await sb
    .from('reddit_opportunities')
    .update({ digested_at: new Date().toISOString() })
    .in('id', rows.map((o) => o.id));
  if (e2) throw e2;
  return { items: rows.length, sent: true };
}

module.exports = { sendInstantAlerts, sendDigest };
