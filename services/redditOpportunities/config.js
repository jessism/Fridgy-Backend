/**
 * Reddit opportunities monitor — knobs.
 *
 * Source: F5Bot keyword alerts (free tier: ~5 keywords, ~2h delay) mailed to
 * REDDIT_ALERT_MAILBOX. Keywords are configured on f5bot.com, not here.
 *
 * Plan: trackabite-mobile/MD_files/PLAN_REDDIT_ALERT_OCT10.md
 */
const TIMEZONE = 'America/Los_Angeles';

// Anything clearly affirmative counts; unset defaults to ON (same leniency
// rationale as the outreach mailer's flag).
const flag = String(process.env.REDDIT_MONITOR_ENABLED ?? 'true').trim().replace(/^["']|["']$/g, '').toLowerCase();

module.exports = {
  TIMEZONE,
  enabled: !['false', '0', 'no', 'off', 'disabled'].includes(flag),

  // The mailbox F5Bot alerts land in. Deliberately NOT GMAIL_SENDER: the
  // outreach reply scan lists that inbox capped at 200 messages and alert
  // volume would crowd real creator replies out of its window.
  alertMailbox: process.env.REDDIT_ALERT_MAILBOX || 'hello@trackabite.app',

  cron: {
    ingest: '*/15 * * * *',  // read mailbox → parse → score → instant alerts
    digest: '0 8 * * *',     // yesterday's mid-score finds, one email
  },

  // Ingest re-reads this window every run; the reddit_url unique constraint
  // makes that idempotent, so there is no last-run marker to corrupt.
  gmailQueryWindow: '3d',
  maxEmailsPerRun: 150,

  // Scores are 0–100 from the model. Below keep → status 'filtered' (hidden
  // by default in the console). At or above alert → immediate email with a
  // drafted reply.
  keepScore: 40,
  alertScore: 75,
  maxScoresPerRun: 25,   // LLM calls per 15-min run; backlog carries over
  maxAlertsPerRun: 10,   // sanity cap on instant emails per run

  // Subreddits where a plug lands especially well; named in the scoring
  // prompt as a boost, never a hard filter.
  targetSubreddits: [
    'Cooking', 'cookingforbeginners', 'recipes', 'MealPrepSunday', 'mealprep',
    'EatCheapAndHealthy', 'ZeroWaste', 'Frugal', 'budgetfood', 'GroceryLists',
  ],

  // google/gemini-2.5-flash expires on OpenRouter 2026-10-20 — swap here.
  model: 'google/gemini-2.5-flash',
  fallbackModel: 'google/gemini-2.5-flash-lite',

  dashboardUrl: 'https://trackabite.app/admin/reddit',
};
