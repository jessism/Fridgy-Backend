/**
 * Creator-facing email, sent as the GMAIL_SENDER mailbox.
 *
 * Two transports. The Gmail HTTPS API is used wherever a service account is
 * configured — Railway blocks outbound SMTP, and the API also files the message
 * in the mailbox's own Sent folder. SMTP with an app password remains for hosts
 * that allow it (local development).
 *
 * NOT Postmark. Postmark's terms ban cold outreach and a violation could
 * suspend the app's transactional mail. This transport is only for outreach.
 *
 * Env: GMAIL_SENDER, OUTREACH_EMAIL_ENABLED ('true' to send), then either
 * GOOGLE_SERVICE_ACCOUNT_JSON (Gmail API, needs domain-wide delegation for the
 * gmail.send scope) or GMAIL_APP_PASSWORD (SMTP). OUTREACH_MAIL_TRANSPORT
 * forces one.
 */
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const MailComposer = require('nodemailer/lib/mail-composer');
const { google } = require('googleapis');
const { getServiceClient } = require('../../config/supabase');
const config = require('./config');

const GMAIL_SEND_SCOPE = 'https://www.googleapis.com/auth/gmail.send';

function serviceAccount() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) return null;
  try {
    const creds = JSON.parse(raw);
    return creds.client_email && creds.private_key ? creds : null;
  } catch {
    return null;
  }
}

/**
 * Which way mail leaves the box.
 *
 * Railway blocks outbound SMTP (465 and 587 both time out), so on a host like
 * that the only route to Gmail is its HTTPS API. The API also puts the message
 * in the mailbox's own Sent folder, which SMTP does not.
 * Override with OUTREACH_MAIL_TRANSPORT=smtp|gmail_api.
 */
function transportName() {
  const explicit = String(process.env.OUTREACH_MAIL_TRANSPORT || '').trim().toLowerCase();
  if (explicit === 'smtp' || explicit === 'gmail_api') return explicit;
  return serviceAccount() ? 'gmail_api' : 'smtp';
}

/** Send through the Gmail API as GMAIL_SENDER, via domain-wide delegation. */
async function gmailApiSend(message) {
  const creds = serviceAccount();
  const auth = new google.auth.JWT({
    email: creds.client_email,
    key: creds.private_key,
    scopes: [GMAIL_SEND_SCOPE],
    subject: process.env.GMAIL_SENDER, // impersonate the mailbox
  });

  // Own the Message-ID so replies can be threaded back to this touch.
  const messageId = `<${crypto.randomUUID()}@trackabite.app>`;
  const raw = await new MailComposer({ ...message, messageId }).compile().build();

  try {
    const gmail = google.gmail({ version: 'v1', auth });
    await gmail.users.messages.send({ userId: 'me', requestBody: { raw: raw.toString('base64url') } });
    return { messageId };
  } catch (e) {
    const detail = e?.response?.data?.error_description || e?.response?.data?.error?.message || e.message;
    if (/unauthorized_client|Client is unauthorized/i.test(String(detail))) {
      throw new Error(
        `Gmail rejected the service account: grant domain-wide delegation to client ID ${creds.client_id} `
        + `with the scope ${GMAIL_SEND_SCOPE} (Admin console → Security → Access and data control → API controls)`,
      );
    }
    if (/Precondition check failed|Delegation denied|failedPrecondition/i.test(String(detail))) {
      throw new Error(`Gmail refused to send as ${process.env.GMAIL_SENDER} — check that mailbox exists and delegation covers it (${detail})`);
    }
    throw new Error(detail);
  }
}

/**
 * Gmail SMTP, tried on 465 then 587.
 *
 * Timeouts are short on purpose: nodemailer defaults to two minutes, so a
 * blocked port left the dashboard's Send button spinning with no feedback at
 * all. Failing in seconds with a real message is far more useful.
 */
const SMTP_PORTS = [
  { port: 465, secure: true },
  { port: 587, secure: false, requireTLS: true },
];

const makeTransport = ({ port, secure, requireTLS }) => nodemailer.createTransport({
  host: 'smtp.gmail.com',
  port,
  secure,
  requireTLS,
  auth: { user: process.env.GMAIL_SENDER, pass: process.env.GMAIL_APP_PASSWORD },
  connectionTimeout: 15000,
  greetingTimeout: 10000,
  socketTimeout: 20000,
});

/** Send over whichever port is reachable; the last error wins if none are. */
async function smtpSend(message) {
  let lastError;
  for (const opts of SMTP_PORTS) {
    try {
      return await makeTransport(opts).sendMail(message);
    } catch (e) {
      lastError = e;
      const networkLevel = ['ETIMEDOUT', 'ESOCKET', 'ECONNECTION', 'ECONNREFUSED'].includes(e.code);
      console.error(`[Outreach] SMTP :${opts.port} failed — ${e.code || 'error'}: ${e.message}`);
      if (!networkLevel) break; // a rejected login will not fare better on another port
    }
  }
  const hint = ['ETIMEDOUT', 'ESOCKET', 'ECONNECTION'].includes(lastError?.code)
    ? ' (the host appears to block outbound SMTP — Railway does by default)'
    : '';
  throw new Error(`${lastError?.message || 'SMTP send failed'}${hint}`);
}

function isConfigured() {
  if (!process.env.GMAIL_SENDER) return false;
  return transportName() === 'gmail_api' ? Boolean(serviceAccount()) : Boolean(process.env.GMAIL_APP_PASSWORD);
}

/** One place that decides how a message actually leaves. */
async function deliver(message) {
  return transportName() === 'gmail_api' ? gmailApiSend(message) : smtpSend(message);
}

// A kill switch that silently ignores "TRUE" or a value someone pasted with
// quotes is worse than a lenient one: the failure is an inert button with no
// explanation. Anything clearly affirmative counts.
const AFFIRMATIVE = new Set(['true', '1', 'yes', 'on', 'enabled']);
const flagValue = () => String(process.env.OUTREACH_EMAIL_ENABLED ?? '').trim().replace(/^["']|["']$/g, '');
const isFlagOn = () => AFFIRMATIVE.has(flagValue().toLowerCase());

function isEnabled() {
  return isFlagOn() && isConfigured();
}

/** null when sending is ready, otherwise exactly what is missing. Never a secret. */
function statusReason() {
  const missing = [];
  if (!process.env.GMAIL_SENDER) missing.push('GMAIL_SENDER');
  if (transportName() === 'gmail_api') {
    if (!serviceAccount()) missing.push('GOOGLE_SERVICE_ACCOUNT_JSON (needed to send through the Gmail API)');
  } else if (!process.env.GMAIL_APP_PASSWORD) {
    missing.push('GMAIL_APP_PASSWORD');
  }
  if (missing.length) {
    return `${missing.join(' and ')} ${missing.length > 1 ? 'are' : 'is'} not set on the server`;
  }
  if (!isFlagOn()) {
    const raw = flagValue();
    return raw
      ? `OUTREACH_EMAIL_ENABLED is set to "${raw.slice(0, 20)}" — it needs to be true`
      : 'OUTREACH_EMAIL_ENABLED is not set — add it with the value true';
  }
  return null;
}

/** Creator emails sent today (UTC), for the daily cap. */
async function sentTodayCount() {
  const sb = getServiceClient();
  const start = new Date();
  start.setUTCHours(0, 0, 0, 0);
  const { count, error } = await sb
    .from('influencer_touches')
    .select('id', { count: 'exact', head: true })
    .eq('channel', 'email')
    .not('sent_at', 'is', null)
    .gte('sent_at', start.toISOString());
  if (error) throw error;
  return count || 0;
}

/**
 * Send one plain-text email to a creator. Returns { messageId }.
 * Throws with a clear message when disabled, unconfigured, or over cap.
 */
async function sendCreatorEmail({ to, subject, text, inReplyTo }) {
  const blocked = statusReason();
  if (blocked) throw new Error(`Cannot send: ${blocked}`);

  const sent = await sentTodayCount();
  if (sent >= config.emailDailyCap) throw new Error(`Daily creator email cap reached (${config.emailDailyCap})`);

  const from = `"${config.fromName}" <${process.env.GMAIL_SENDER}>`;

  const info = await deliver({
    from,
    to,
    replyTo: process.env.GMAIL_SENDER,
    subject,
    text: `${text.trimEnd()}\n`,
    ...(inReplyTo ? { inReplyTo, references: inReplyTo } : {}),
  });
  return { messageId: info.messageId };
}

/** Internal notifications (to Jessie). Same transport, no cap. */
async function sendInternal({ subject, text }) {
  const to = process.env.NOTIFY_EMAIL || process.env.GMAIL_SENDER;
  if (!isConfigured() || !to) {
    console.log('[Outreach] notify skipped (mail not configured):', subject);
    return null;
  }
  const info = await deliver({
    from: `"Trackabite outreach" <${process.env.GMAIL_SENDER}>`,
    to,
    subject,
    text,
  });
  return info.messageId;
}

module.exports = { sendCreatorEmail, sendInternal, isConfigured, isEnabled, statusReason, sentTodayCount };
