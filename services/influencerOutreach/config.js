/**
 * Influencer outreach cadence and caps. Discovery-side knobs (pool, pricing,
 * hashtags) live in trackabite-outreach/config.yaml.
 *
 * Plan: trackabite-mobile/MD_files/PLAN_INFLUENCER_AGENT_SPT13.md
 */
const TIMEZONE = 'America/Los_Angeles';

module.exports = {
  TIMEZONE,

  // Two evening sessions a week; each closes the last batch and opens the next.
  sessionDays: [1, 4],            // 1 = Monday, 4 = Thursday (cron weekday numbers)
  batchSize: 10,

  // Warm-up per creator: like all posts, comment on `warmupComments` of them
  // (2 when the batch opens, 1 when it closes). Purely advisory in the UI.
  warmupLikes: 5,
  warmupComments: 3,

  // Days after the previous touch. 4 touches total, then no_response after the
  // last gap elapses again.
  followupsDays: [7, 14, 14],
  // Which touches get a DM task on top of the email. 1 = first contact.
  dmOnTouches: [1, 2],

  // Creator-facing email caps (per UTC day).
  emailDailyCap: 30,

  cron: {
    evening: '0 18 * * *',        // follow-up emails + no_response sweep, every day
    digest: '0 18 * * 1,4',       // "tonight" email to Jessie on session days
    imap: '*/30 * * * *',         // reply / bounce / STOP scan
    mirror: '0 2 * * *',          // Google Sheet archive
  },

  // Email identity. GMAIL_SENDER is the mailbox (jessie@trackabite.app).
  // No footer is appended: the email body is exactly the draft.
  fromName: 'Jessie at Trackabite',

  dashboardUrl: process.env.OUTREACH_DASHBOARD_URL || 'https://trackabite.app/admin/influencers',

  // The archive sheet the nightly mirror writes to. Null when unset, and the
  // dashboard simply omits the link.
  get sheetUrl() {
    const id = process.env.OUTREACH_SHEET_ID;
    return id ? `https://docs.google.com/spreadsheets/d/${id}/edit` : null;
  },
};
