/**
 * Build and send touch N (1 = first contact, 2–4 = follow-ups) for one creator.
 *
 * Touch 1 uses the approved draft on the influencer row. Follow-ups are
 * generated with Gemini (OpenRouter) from prompts/followup.md, threaded onto
 * the first email via In-Reply-To so replies match.
 *
 * Every attempt writes an influencer_touches row; failures land in `error`
 * and on influencers.email_error so the dashboard can show a retry.
 */
const fs = require('fs');
const path = require('path');
const { getServiceClient } = require('../../config/supabase');
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
 * Send the email for `step`. Returns the touch row (sent or errored).
 * If the creator has no email, records nothing and returns null.
 */
async function sendEmailTouch(inf, step) {
  if (!inf.email) return null;
  const sb = getServiceClient();

  // First email's Message-ID threads the follow-ups.
  let inReplyTo = null;
  if (step > 1) {
    const { data: first } = await sb
      .from('influencer_touches')
      .select('message_id')
      .eq('influencer_id', inf.id)
      .eq('channel', 'email')
      .eq('step', 1)
      .not('message_id', 'is', null)
      .maybeSingle();
    inReplyTo = first?.message_id || null;
  }

  let subject; let body;
  try {
    ({ subject, body } = await buildEmail(inf, step));
  } catch (e) {
    const row = await recordTouch(sb, inf.id, step, 'email', { subject: null, body: null, error: `build: ${e.message}` });
    await sb.from('influencers').update({ email_error: e.message }).eq('id', inf.id);
    return row;
  }

  try {
    const { messageId } = await mailer.sendCreatorEmail({ to: inf.email, subject, text: body, inReplyTo });
    const row = await recordTouch(sb, inf.id, step, 'email', {
      subject, body, sent_at: new Date().toISOString(), sent_by: 'auto', message_id: messageId,
    });
    await sb.from('influencers').update({ email_error: null }).eq('id', inf.id);
    return row;
  } catch (e) {
    const row = await recordTouch(sb, inf.id, step, 'email', { subject, body, error: e.message });
    await sb.from('influencers').update({ email_error: e.message }).eq('id', inf.id);
    return row;
  }
}

/** Retry an errored email touch in place (used by the retry button + nightly sweep). */
async function retryEmailTouch(touch, inf) {
  const sb = getServiceClient();
  let subject = touch.subject; let body = touch.body;
  try {
    if (!body) ({ subject, body } = await buildEmail(inf, touch.step));
    let inReplyTo = null;
    if (touch.step > 1) {
      const { data: first } = await sb.from('influencer_touches').select('message_id')
        .eq('influencer_id', inf.id).eq('channel', 'email').eq('step', 1).not('message_id', 'is', null).maybeSingle();
      inReplyTo = first?.message_id || null;
    }
    const { messageId } = await mailer.sendCreatorEmail({ to: inf.email, subject, text: body, inReplyTo });
    const { data } = await sb.from('influencer_touches')
      .update({ subject, body, sent_at: new Date().toISOString(), sent_by: 'auto', message_id: messageId, error: null })
      .eq('id', touch.id).select('*').single();
    await sb.from('influencers').update({ email_error: null }).eq('id', inf.id);
    return data;
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

module.exports = { sendEmailTouch, retryEmailTouch, createDmTask, firstName };
