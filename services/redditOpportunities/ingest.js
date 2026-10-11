/**
 * Pull F5Bot alert emails from the alert mailbox and store the Reddit hits.
 *
 * Reads over the Gmail HTTPS API with the same service account as the
 * outreach mailer, but impersonating config.alertMailbox (domain-wide
 * delegation covers every mailbox in the domain, so no extra Admin-console
 * grant is needed).
 *
 * Stateless on purpose: every run re-reads the last few days of F5Bot mail
 * and upserts with ignoreDuplicates on reddit_url, so a crashed run needs no
 * recovery and a format fix can simply be re-run.
 */
const { google } = require('googleapis');
const { getServiceClient } = require('../../config/supabase');
const config = require('./config');
const { parseAlertEmail } = require('./parser');

const GMAIL_READ_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';

function gmailClient() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) return null;
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
    subject: config.alertMailbox, // NOT GMAIL_SENDER — see config.js
  });
  return google.gmail({ version: 'v1', auth });
}

/** Plain-text body, walking the MIME parts Gmail returns. */
function plainText(payload, depth = 0) {
  if (!payload || depth > 6) return '';
  if (payload.mimeType === 'text/plain' && payload.body?.data) {
    return Buffer.from(payload.body.data, 'base64').toString('utf8');
  }
  return (payload.parts || []).map((p) => plainText(p, depth + 1)).join('\n');
}

async function ingest() {
  const gmail = gmailClient();
  if (!gmail) return { skipped: 'Gmail API not configured (GOOGLE_SERVICE_ACCOUNT_JSON)' };
  const sb = getServiceClient();

  // Emails that already produced rows need not be fetched again. Purely an
  // optimization — correctness still rests on the reddit_url upsert.
  const since = new Date(Date.now() - 4 * 86400000).toISOString();
  const { data: done, error: doneErr } = await sb
    .from('reddit_opportunities')
    .select('gmail_id:raw->>gmail_id')
    .gte('created_at', since);
  if (doneErr) throw doneErr;
  const processed = new Set((done || []).map((r) => r.gmail_id).filter(Boolean));

  const summary = { emails: 0, skipped: 0, hits: 0, inserted: 0 };
  let pageToken;
  do {
    const list = await gmail.users.messages.list({
      userId: 'me',
      q: `from:f5bot.com newer_than:${config.gmailQueryWindow}`,
      maxResults: Math.min(100, config.maxEmailsPerRun - summary.emails),
      pageToken,
    });
    pageToken = list.data.nextPageToken;

    for (const ref of list.data.messages || []) {
      if (processed.has(ref.id)) { summary.skipped += 1; continue; }
      const { data: message } = await gmail.users.messages.get({ userId: 'me', id: ref.id, format: 'full' });
      summary.emails += 1;

      const hits = parseAlertEmail(plainText(message.payload));
      if (!hits.length) continue;
      summary.hits += hits.length;

      const rows = hits.map(({ raw_block, ...hit }) => ({
        ...hit,
        source: 'f5bot',
        raw: { gmail_id: ref.id, block: raw_block },
      }));
      const { data, error } = await sb
        .from('reddit_opportunities')
        .upsert(rows, { onConflict: 'reddit_url', ignoreDuplicates: true })
        .select('id');
      if (error) throw error;
      summary.inserted += (data || []).length;
    }
  } while (pageToken && summary.emails < config.maxEmailsPerRun);

  return summary;
}

module.exports = { ingest };
