/**
 * Creator-facing email: Gmail SMTP from jessie@trackabite.app via nodemailer.
 *
 * NOT Postmark. Postmark's terms ban cold outreach and a violation could
 * suspend the app's transactional mail. This transport is only for outreach.
 *
 * Env: GMAIL_SENDER, GMAIL_APP_PASSWORD, OUTREACH_EMAIL_ENABLED ('true' to send).
 */
const nodemailer = require('nodemailer');
const { getServiceClient } = require('../../config/supabase');
const config = require('./config');

let transport = null;
function getTransport() {
  if (!transport) {
    transport = nodemailer.createTransport({
      host: 'smtp.gmail.com',
      port: 465,
      secure: true,
      auth: { user: process.env.GMAIL_SENDER, pass: process.env.GMAIL_APP_PASSWORD },
    });
  }
  return transport;
}

function isConfigured() {
  return Boolean(process.env.GMAIL_SENDER && process.env.GMAIL_APP_PASSWORD);
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
  if (!process.env.GMAIL_APP_PASSWORD) missing.push('GMAIL_APP_PASSWORD');
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

  const info = await getTransport().sendMail({
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
  const info = await getTransport().sendMail({
    from: `"Trackabite outreach" <${process.env.GMAIL_SENDER}>`,
    to,
    subject,
    text,
  });
  return info.messageId;
}

module.exports = { sendCreatorEmail, sendInternal, isConfigured, isEnabled, statusReason, sentTodayCount };
