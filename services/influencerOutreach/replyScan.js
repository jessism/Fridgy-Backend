/**
 * Scan the outreach mailbox (IMAP) for replies, bounces and STOP requests.
 *
 * Matching, in order: In-Reply-To / References against stored Message-IDs;
 * then the From address against influencers.email. A body or subject
 * containing a standalone "STOP" → opted_out. Mailer-daemon messages that
 * mention a creator's address → bounced.
 *
 * Runs every 30 min when GMAIL_SENDER / GMAIL_APP_PASSWORD are set. Looks
 * back 21 days; idempotent because it only moves creators forward.
 */
const { ImapFlow } = require('imapflow');
const { getServiceClient } = require('../../config/supabase');
const { update } = require('./stateMachine');

const LOOKBACK_DAYS = 21;
const STOP_RE = /(^|\W)(stop|unsubscribe)(\W|$)/i;

function extractAddress(addr) {
  return (addr || '').toLowerCase().replace(/.*<([^>]+)>.*/, '$1').trim();
}

async function scan() {
  if (!process.env.GMAIL_SENDER || !process.env.GMAIL_APP_PASSWORD) return { skipped: 'not configured' };
  const sb = getServiceClient();

  // Creators we might hear from: anything contacted and not yet closed.
  const { data: contacted, error } = await sb
    .from('influencers')
    .select('id, handle, email, status, contacted_at')
    .in('status', ['dm_needed', 'contacted', 'followup_needed'])
    .not('email', 'is', null);
  if (error) throw error;
  if (!contacted.length) return { candidates: 0 };

  const byEmail = new Map(contacted.map((c) => [c.email.toLowerCase(), c]));
  const { data: touches } = await sb
    .from('influencer_touches')
    .select('influencer_id, message_id')
    .in('influencer_id', contacted.map((c) => c.id))
    .not('message_id', 'is', null);
  const byMessageId = new Map((touches || []).map((t) => [t.message_id, t.influencer_id]));
  const byId = new Map(contacted.map((c) => [c.id, c]));

  const client = new ImapFlow({
    host: 'imap.gmail.com',
    port: 993,
    secure: true,
    auth: { user: process.env.GMAIL_SENDER, pass: process.env.GMAIL_APP_PASSWORD },
    logger: false,
  });

  const summary = { candidates: contacted.length, replied: 0, optedOut: 0, bounced: 0, scanned: 0 };
  await client.connect();
  try {
    const lock = await client.getMailboxLock('INBOX');
    try {
      const since = new Date(Date.now() - LOOKBACK_DAYS * 86400000);
      for await (const msg of client.fetch({ since }, { envelope: true, headers: ['in-reply-to', 'references'], bodyParts: ['1'] })) {
        summary.scanned += 1;
        const env = msg.envelope || {};
        const from = extractAddress(env.from?.[0]?.address);
        const headers = (msg.headers || Buffer.alloc(0)).toString();
        const refs = `${headers}`.match(/<[^>]+>/g) || [];
        const subject = env.subject || '';
        const textPart = msg.bodyParts?.get('1')?.toString('utf8') || '';

        let inf = null;
        for (const ref of refs) {
          const id = byMessageId.get(ref);
          if (id) { inf = byId.get(id); break; }
        }
        if (!inf && from && byEmail.has(from)) inf = byEmail.get(from);

        // Bounces come from mailer-daemon and mention the failed address in the body.
        if (!inf && /mailer-daemon|postmaster/i.test(from)) {
          for (const [email, c] of byEmail) {
            if (textPart.toLowerCase().includes(email)) { inf = c; break; }
          }
          if (inf && inf.status !== 'bounced') {
            await update(inf.id, { status: 'bounced', next_touch_at: null, email_error: 'bounced' });
            inf.status = 'bounced';
            summary.bounced += 1;
          }
          continue;
        }
        if (!inf) continue;

        // Only messages received after we first contacted them count as replies.
        if (inf.contacted_at && env.date && new Date(env.date) < new Date(inf.contacted_at)) continue;

        if (STOP_RE.test(subject) || STOP_RE.test(textPart.slice(0, 2000))) {
          if (inf.status !== 'opted_out') {
            await update(inf.id, { status: 'opted_out', next_touch_at: null, replied_at: new Date().toISOString(), reply_channel: 'email' });
            inf.status = 'opted_out';
            summary.optedOut += 1;
          }
        } else if (['dm_needed', 'contacted', 'followup_needed'].includes(inf.status)) {
          await update(inf.id, { status: 'replied', replied_at: new Date().toISOString(), reply_channel: 'email', next_touch_at: null });
          inf.status = 'replied';
          summary.replied += 1;
        }
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => {});
  }
  return summary;
}

module.exports = { scan };
