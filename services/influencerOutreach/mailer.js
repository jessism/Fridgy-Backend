/**
 * Creator-facing email: Gmail SMTP from jessie@trackabite.app via nodemailer.
 *
 * NOT Postmark. Postmark's terms ban cold outreach and a violation could
 * suspend the app's transactional mail. This transport is only for outreach.
 *
 * Env: GMAIL_SENDER, GMAIL_APP_PASSWORD, OUTREACH_EMAIL_ENABLED ('true' to send),
 *      OUTREACH_MAILING_ADDRESS (footer).
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

function isEnabled() {
  return process.env.OUTREACH_EMAIL_ENABLED === 'true' && isConfigured();
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
  if (!isConfigured()) throw new Error('Outreach email not configured (GMAIL_SENDER / GMAIL_APP_PASSWORD)');
  if (!isEnabled()) throw new Error('Outreach email disabled (OUTREACH_EMAIL_ENABLED != true)');

  const sent = await sentTodayCount();
  if (sent >= config.emailDailyCap) throw new Error(`Daily creator email cap reached (${config.emailDailyCap})`);

  const from = `"${config.fromName}" <${process.env.GMAIL_SENDER}>`;
  const body = `${text.trimEnd()}\n${config.footer(process.env.OUTREACH_MAILING_ADDRESS)}\n`;

  const info = await getTransport().sendMail({
    from,
    to,
    replyTo: process.env.GMAIL_SENDER,
    subject,
    text: body,
    ...(inReplyTo ? { inReplyTo, references: inReplyTo } : {}),
  });
  return { messageId: info.messageId };
}

/** Internal notifications (to Jessie). Same transport, no cap, no footer. */
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

module.exports = { sendCreatorEmail, sendInternal, isConfigured, isEnabled, sentTodayCount };
