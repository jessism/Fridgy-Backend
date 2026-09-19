/**
 * Build touch N (1 = first contact, 2–4 = follow-ups) for one creator.
 *
 * Nothing is ever sent without a click: touch 1 is prepared when warm-up
 * finishes, follow-ups are prepared by the evening cron when they fall due, and
 * both sit on the dashboard as editable drafts until Send is pressed. Follow-up
 * bodies are generated with Gemini (OpenRouter) from prompts/followup.md and
 * threaded onto the first email via In-Reply-To so replies match.
 *
 * Every attempt writes an influencer_touches row; failures land in `error`
 * and on influencers.email_error so the dashboard can show a retry.
 */
const fs = require('fs');
const path = require('path');
const { getServiceClient } = require('../../config/supabase');
const config = require('./config');
const mailer = require('./mailer');

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const MODEL = 'google/gemini-2.5-flash';
const FALLBACK_MODEL = 'google/gemini-2.5-flash-lite';

const FOLLOWUP_SUBJECTS = {
  2: 'Re: Paid collab with Trackabite?',
  3: 'Re: Paid collab with Trackabite?',
  4: 'Re: Paid collab with Trackabite?',
};

function render(name, vars) {
  let text = fs.readFileSync(path.join(__dirname, 'prompts', `${name}.md`), 'utf8');
  for (const [k, v] of Object.entries(vars)) text = text.split(`{{${k}}}`).join(String(v ?? ''));
  return text;
}

async function completeJson(prompt) {
  let lastError;
  for (const model of [MODEL, FALLBACK_MODEL]) {
    try {
      const res = await fetch(OPENROUTER_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://trackabite.app',
          'X-Title': 'Trackabite influencer outreach',
        },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: prompt }],
          response_format: { type: 'json_object' },
          temperature: 0.6,
          max_tokens: 500,
        }),
      });
      if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const data = await res.json();
      let content = data.choices?.[0]?.message?.content || '';
      content = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
      return JSON.parse(content);
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError;
}

function firstName(inf) {
  const token = (inf.display_name || '').trim().split(/\s+/)[0]?.replace(/[^A-Za-z'-]/g, '') || '';
  return token.length >= 2 && token.length <= 20 ? token[0].toUpperCase() + token.slice(1) : inf.handle;
}

async function buildEmail(inf, step) {
  if (step === 1) {
    return { subject: inf.draft_email_subject || 'Paid collab with Trackabite?', body: inf.draft_email || inf.draft_dm };
  }
  const out = await completeJson(render('followup', {
    name: firstName(inf),
    handle: inf.handle,
    step_label: step - 1,
    evidence: inf.evidence_caption || '',
  }));
  const body = String(out.body || '').trim();
  if (body.length < 20) throw new Error('Follow-up generation returned an empty body');
  return { subject: FOLLOWUP_SUBJECTS[step], body };
}

/**
 * A touch only counts once it is actually sent, and the next one is scheduled
 * from that moment. Drafting does nothing to the clock, so an unsent follow-up
 * can never stack another one behind it. Idempotent per step: whichever channel
 * goes out first (email or DM) advances it, the second is a no-op.
 */
function advanceSchedule(inf, step, sentAt) {
  const patch = { last_touch_at: sentAt };
  if (!inf.contacted_at) patch.contacted_at = sentAt;
  if ((inf.touches_sent || 0) >= step) return patch;

  const gaps = config.followupsDays;
  const gap = gaps[Math.min(step - 1, gaps.length - 1)];
  patch.touches_sent = step;
  patch.next_touch_at = new Date(new Date(sentAt).getTime() + gap * 86400000).toISOString();
  return patch;
}

/** Back to plain 'contacted' once nothing is left for a human to send. */
async function settleStatus(sb, inf) {
  if (!['dm_needed', 'followup_needed'].includes(inf.status)) return {};
  const { count, error } = await sb
    .from('influencer_touches')
    .select('id', { count: 'exact', head: true })
    .eq('influencer_id', inf.id)
    .is('sent_at', null);
  if (error) throw error;
  return count ? {} : { status: 'contacted' };
}

/** The first email's Message-ID, so follow-ups thread onto it. */
async function threadRoot(sb, influencerId, step) {
  if (step <= 1) return null;
  const { data } = await sb
    .from('influencer_touches')
    .select('message_id')
    .eq('influencer_id', influencerId)
    .eq('channel', 'email')
    .eq('step', 1)
    .not('message_id', 'is', null)
    .maybeSingle();
  return data?.message_id || null;
}

/**
 * Write the email for `step` as a PENDING touch — drafted, nothing sent. The
 * dashboard shows it for review and sends it with sendPreparedTouch.
 * Returns null when the creator has no email address.
 */
async function prepareEmailTouch(inf, step) {
  if (!inf.email) return null;
  const sb = getServiceClient();
  try {
    const { subject, body } = await buildEmail(inf, step);
    return await recordTouch(sb, inf.id, step, 'email', {
      subject, body, scheduled_for: new Date().toISOString(),
    });
  } catch (e) {
    const row = await recordTouch(sb, inf.id, step, 'email', { subject: null, body: null, error: `build: ${e.message}` });
    await sb.from('influencers').update({ email_error: e.message }).eq('id', inf.id);
    return row;
  }
}

/**
 * Send a prepared (or previously failed) email touch. Rebuilds the body if the
 * draft never got written. Throws on failure, leaving the error on the row so
 * the dashboard can offer a retry.
 */
async function sendPreparedTouch(touchId, sentBy = 'human') {
  const sb = getServiceClient();
  const { data: touch, error } = await sb
    .from('influencer_touches')
    .select('*, influencers(*)')
    .eq('id', touchId)
    .maybeSingle();
  if (error) throw error;
  if (!touch) throw Object.assign(new Error('Touch not found'), { status: 404 });
  if (touch.sent_at) throw Object.assign(new Error('That email was already sent'), { status: 409 });

  const inf = touch.influencers;
  if (!inf?.email) throw Object.assign(new Error('Creator has no email address'), { status: 409 });

  let subject = touch.subject;
  let body = touch.body;
  try {
    if (!body) ({ subject, body } = await buildEmail(inf, touch.step));
    const inReplyTo = await threadRoot(sb, inf.id, touch.step);
    const { messageId } = await mailer.sendCreatorEmail({ to: inf.email, subject, text: body, inReplyTo });
    const sentAt = new Date().toISOString();

    const { data: saved } = await sb.from('influencer_touches')
      .update({ subject, body, sent_at: sentAt, sent_by: sentBy, message_id: messageId, error: null })
      .eq('id', touch.id).select('*').single();

    await sb.from('influencers').update({
      email_error: null,
      ...advanceSchedule(inf, touch.step, sentAt),
      ...(await settleStatus(sb, inf)),
    }).eq('id', inf.id);
    return saved;
  } catch (e) {
    await sb.from('influencer_touches').update({ subject, body, error: e.message }).eq('id', touch.id);
    await sb.from('influencers').update({ email_error: e.message }).eq('id', inf.id);
    throw e;
  }
}

/** Create the DM task row for `step` with the draft the human will copy. */
async function createDmTask(inf, step) {
  const sb = getServiceClient();
  const body = step === 1 ? inf.draft_dm : followupDm(inf);
  return recordTouch(sb, inf.id, step, 'dm', { body, scheduled_for: new Date().toISOString() });
}

function followupDm(inf) {
  return `Hey ${firstName(inf)}, just floating this back up in case it got buried. Still keen to send you the brief for a paid Trackabite collab if you're interested. No worries at all if it's not for you. ❤️`;
}

async function recordTouch(sb, influencerId, step, channel, fields) {
  const { data, error } = await sb
    .from('influencer_touches')
    .insert({ influencer_id: influencerId, step, channel, ...fields })
    .select('*')
    .single();
  if (error) throw error;
  return data;
}

module.exports = { prepareEmailTouch, sendPreparedTouch, createDmTask, advanceSchedule, settleStatus, firstName };
