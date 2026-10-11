/**
 * LLM relevance scoring for ingested Reddit hits.
 *
 * One OpenRouter call per unscored row (same call shape as the outreach
 * follow-up generator, with a higher max_tokens since a drafted reply is
 * longer than a follow-up email). Below config.keepScore the row is filtered
 * out of the default console view; at or above config.alertScore the model
 * also drafts a reply, which the instant alert email carries.
 */
const fs = require('fs');
const path = require('path');
const { getServiceClient } = require('../../config/supabase');
const { parseAIJson } = require('../aiJsonParser');
const config = require('./config');

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

function render(name, vars) {
  let text = fs.readFileSync(path.join(__dirname, 'prompts', `${name}.md`), 'utf8');
  for (const [k, v] of Object.entries(vars)) text = text.split(`{{${k}}}`).join(String(v ?? ''));
  return text;
}

async function completeJson(prompt) {
  let lastError;
  for (const model of [config.model, config.fallbackModel]) {
    try {
      const res = await fetch(OPENROUTER_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://trackabite.app',
          'X-Title': 'Trackabite reddit monitor',
        },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: prompt }],
          response_format: { type: 'json_object' },
          temperature: 0.4,
          max_tokens: 800,
        }),
      });
      if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const data = await res.json();
      return parseAIJson(data.choices?.[0]?.message?.content || '');
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError;
}

/** Score one row's fields; returns the patch to apply. */
async function scoreHit(row) {
  const out = await completeJson(render('score', {
    subreddit: row.subreddit || 'unknown',
    kind: row.kind || 'post',
    title: row.title || '(title not captured)',
    keyword: row.keyword || '(unknown)',
    excerpt: row.excerpt || '(none)',
    target_subreddits: config.targetSubreddits.map((s) => `r/${s}`).join(', '),
    alert_score: config.alertScore,
  }));

  const score = Math.max(0, Math.min(100, parseInt(out.score, 10) || 0));
  return {
    score,
    score_reason: String(out.reason || '').slice(0, 500) || null,
    category: String(out.category || 'other').slice(0, 40),
    suggested_reply: score >= config.alertScore && out.suggested_reply
      ? String(out.suggested_reply).slice(0, 4000)
      : null,
    ...(score < config.keepScore ? { status: 'filtered' } : {}),
  };
}

/** Score every unscored row, oldest first. A single bad row never stops the batch. */
async function scorePending() {
  const sb = getServiceClient();
  const { data: rows, error } = await sb
    .from('reddit_opportunities')
    .select('id, subreddit, kind, title, keyword, excerpt')
    .is('score', null)
    .eq('status', 'new')
    .order('created_at')
    .limit(config.maxScoresPerRun);
  if (error) throw error;

  const summary = { scored: 0, kept: 0, filtered: 0, failed: 0 };
  for (const row of rows || []) {
    try {
      const patch = await scoreHit(row);
      const { error: e2 } = await sb.from('reddit_opportunities').update(patch).eq('id', row.id);
      if (e2) throw e2;
      summary.scored += 1;
      patch.status === 'filtered' ? summary.filtered++ : summary.kept++;
    } catch (e) {
      summary.failed += 1;
      console.error('[Reddit] scoring failed for', row.id, '—', e.message);
    }
  }
  return summary;
}

/**
 * Re-draft (or first-draft) the reply for one row on demand, regardless of
 * score — the console's "Draft reply" button.
 */
async function draftReply(id) {
  const sb = getServiceClient();
  const { data: row, error } = await sb
    .from('reddit_opportunities')
    .select('id, subreddit, kind, title, keyword, excerpt, score')
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  if (!row) { const e = new Error('Not found'); e.status = 404; throw e; }

  const out = await completeJson(render('score', {
    subreddit: row.subreddit || 'unknown',
    kind: row.kind || 'post',
    title: row.title || '(title not captured)',
    keyword: row.keyword || '(unknown)',
    excerpt: row.excerpt || '(none)',
    target_subreddits: config.targetSubreddits.map((s) => `r/${s}`).join(', '),
    alert_score: 0, // force a draft whatever the score
  }));
  const suggested_reply = String(out.suggested_reply || '').slice(0, 4000) || null;
  if (!suggested_reply) throw new Error('The model returned no reply');

  const { data, error: e2 } = await sb
    .from('reddit_opportunities')
    .update({ suggested_reply })
    .eq('id', id)
    .select('*')
    .single();
  if (e2) throw e2;
  return data;
}

module.exports = { scorePending, draftReply };
