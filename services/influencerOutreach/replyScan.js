/**
 * Scan the outreach mailbox for replies, bounces and STOP requests.
 *
 * Reads over the Gmail HTTPS API rather than IMAP: Railway blocks IMAP just as
 * it blocks SMTP, so imapflow could never connect from production. Same service
 * account and impersonation as the sender (mailer.js), with the gmail.readonly
 * scope.
 *
 * Matching, in order: In-Reply-To / References against stored Message-IDs; then
 * the From address against influencers.email. A body or subject containing a
 * standalone "STOP" → opted_out. Mailer-daemon messages that mention a
 * creator's address → bounced.
 *
 * Runs every 30 minutes. Looks back 21 days; idempotent because it only moves
 * creators forward.
 */
const { google } = require('googleapis');
const { getServiceClient } = require('../../config/supabase');
const { update } = require('./stateMachine');

const LOOKBACK_DAYS = 21;
const MAX_MESSAGES = 200;
const GMAIL_READ_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';

/**
 * Everything the person actually typed, with the quoted original removed.
 *
 * This matters more than it looks: our own email contains the phrase "stop
 * wasting groceries", so scanning a whole reply — which quotes us — flagged
 * genuine replies as opt-outs and buried the creator for good.
 */
function newTextOnly(raw) {
  const kept = [];
  for (const line of String(raw || '').split(/\r?\n/)) {
    if (/^\s*>/.test(line)) break;                              // quoted block
    if (/^\s*On .+wrote:\s*$/i.test(line)) break;               // Gmail attribution
    if (/^\s*-{2,}\s*Original Message\s*-{2,}/i.test(line)) break;
    if (/^\s*_{5,}\s*$/.test(line)) break;                      // Outlook divider
    if (kept.length && /^\s*From:\s+\S+/i.test(line)) break;    // Outlook header block
    kept.push(line);
  }
  return kept.join('\n').trim();
}

// Phrases that only ever mean "leave me alone".
const EXPLICIT_OPT_OUT = /\b(unsubscribe|remove me|opt[-\s]?out|take me off|do ?n'?t (contact|email|message) me|stop (contacting|emailing|messaging) me|no longer (wish|want) to)\b/i;
// A bare "stop" counts only as the whole point of a short message, never inside prose.
const BARE_STOP = /^\s*(please\s+)?stop[\s.!]*$/i;
const SHORT_REPLY = 60;

/** Deliberately conservative: a missed opt-out is rude, a false one loses a creator silently. */
function looksLikeOptOut(subject, newText) {
  if (EXPLICIT_OPT_OUT.test(subject || '')) return true;
  const text = (newText || '').trim();
  if (!text) return false;
  if (EXPLICIT_OPT_OUT.test(text)) return true;
  return text.length <= SHORT_REPLY && BARE_STOP.test(text);
}

function extractAddress(value) {
  return String(value || '').toLowerCase().replace(/.*<([^>]+)>.*/, '$1').trim();
}

function gmailClient() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw || !process.env.GMAIL_SENDER) return null;
  let creds;
  try {
    creds = JSON.parse(raw);
  } catch {
    return null;
  }
  const auth = new google.auth.JWT({
    email: creds.client_email,
    key: creds.private_key,
    scopes: [GMAIL_READ_SCOPE],
    subject: process.env.GMAIL_SENDER,
  });
  return google.gmail({ version: 'v1', auth });
}

const header = (message, name) =>
  (message.payload?.headers || []).find((h) => h.name.toLowerCase() === name)?.value || '';

/** Plain-text body, walking the MIME parts Gmail returns. */
function plainText(payload, depth = 0) {
  if (!payload || depth > 6) return '';
  if (payload.mimeType === 'text/plain' && payload.body?.data) {
    return Buffer.from(payload.body.data, 'base64').toString('utf8');
  }
  return (payload.parts || []).map((p) => plainText(p, depth + 1)).join('\n');
}

async function scan() {
  const gmail = gmailClient();
  if (!gmail) return { skipped: 'Gmail API not configured (GMAIL_SENDER + GOOGLE_SERVICE_ACCOUNT_JSON)' };
  const sb = getServiceClient();

  // Creators we might hear from: contacted and not yet closed.
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

  const summary = { candidates: contacted.length, scanned: 0, replied: 0, optedOut: 0, bounced: 0 };

  const list = await gmail.users.messages.list({
    userId: 'me',
    q: `newer_than:${LOOKBACK_DAYS}d -from:me`,
    maxResults: MAX_MESSAGES,
  });

  for (const ref of list.data.messages || []) {
    const { data: message } = await gmail.users.messages.get({ userId: 'me', id: ref.id, format: 'full' });
    summary.scanned += 1;

    const from = extractAddress(header(message, 'from'));
    const subject = header(message, 'subject');
    const refs = `${header(message, 'in-reply-to')} ${header(message, 'references')}`.match(/<[^>]+>/g) || [];
    const receivedAt = Number(message.internalDate) || Date.now();

    let inf = null;
    for (const id of refs) {
      const influencerId = byMessageId.get(id);
      if (influencerId) { inf = byId.get(influencerId); break; }
    }
    if (!inf && from && byEmail.has(from)) inf = byEmail.get(from);

    // Bounces come from mailer-daemon and name the failed address in the body.
    if (!inf && /mailer-daemon|postmaster/i.test(from)) {
      const body = plainText(message.payload).toLowerCase(); // bounces quote nothing useful
      for (const [email, creator] of byEmail) {
        if (body.includes(email)) { inf = creator; break; }
      }
      if (inf && inf.status !== 'bounced') {
        await update(inf.id, { status: 'bounced', next_touch_at: null, email_error: 'bounced' });
        inf.status = 'bounced';
        summary.bounced += 1;
      }
      continue;
    }
    if (!inf) continue;

    // Only messages received after we first wrote to them count as replies.
    if (inf.contacted_at && receivedAt < new Date(inf.contacted_at).getTime()) continue;

    const body = newTextOnly(plainText(message.payload)).slice(0, 2000);
    if (looksLikeOptOut(subject, body)) {
      if (inf.status !== 'opted_out') {
        await update(inf.id, {
          status: 'opted_out', next_touch_at: null, replied_at: new Date().toISOString(), reply_channel: 'email',
        });
        inf.status = 'opted_out';
        summary.optedOut += 1;
      }
    } else if (['dm_needed', 'contacted', 'followup_needed'].includes(inf.status)) {
      await update(inf.id, {
        status: 'replied', replied_at: new Date().toISOString(), reply_channel: 'email', next_touch_at: null,
      });
      inf.status = 'replied';
      summary.replied += 1;
    }
  }

  return summary;
}

module.exports = { scan, newTextOnly, looksLikeOptOut };
