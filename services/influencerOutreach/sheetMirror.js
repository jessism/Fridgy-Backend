/**
 * One-way archive of the pipeline into the existing Google Sheet
 * "Trackabite Influencer Tracker". Supabase is the source of truth; edits in
 * the sheet are never read back.
 *
 * Tabs: Pipeline (one row per creator, upserted by handle), Touches (append
 * per sent touch), Runs (append per discovery run).
 *
 * Env: OUTREACH_SHEET_ID, GOOGLE_SERVICE_ACCOUNT_JSON (the key file contents).
 */
const { google } = require('googleapis');
const { getServiceClient } = require('../../config/supabase');

const PIPELINE_HEADERS = [
  'Username', 'Profile Link', 'Platform', 'Followers', 'Bio', 'Category', 'Score', 'Reason',
  'Website/Linktree', 'Draft Message', 'Followed?', 'Interacted?', 'DM Sent?', 'Response?', 'Notes', 'Found Date',
  'Status', 'Email', 'Recommended Fee', 'Agreed Fee', 'Approved', 'Warm-up done', 'Touches sent',
  'Last touch', 'Next touch', 'Replied', 'Outcome', 'Batch', 'Updated (mirror is one-way; edits here are ignored)',
];
const TOUCH_HEADERS = ['Sent at', 'Username', 'Step', 'Channel', 'Sent by', 'Subject', 'Message ID'];
const RUN_HEADERS = ['Started', 'Platform', 'Hashtags', 'Candidates', 'Added', 'Apify runs', 'Error'];

function isConfigured() {
  return Boolean(process.env.OUTREACH_SHEET_ID && process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
}

function sheetsClient() {
  const creds = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const auth = new google.auth.GoogleAuth({ credentials: creds, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
  return google.sheets({ version: 'v4', auth });
}

async function ensureTab(sheets, spreadsheetId, title, headers) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const exists = meta.data.sheets.some((s) => s.properties.title === title);
  if (!exists) {
    await sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests: [{ addSheet: { properties: { title } } }] } });
  }
  const { data } = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${title}!1:1` });
  const current = data.values?.[0] || [];
  if (current.length < headers.length) {
    await sheets.spreadsheets.values.update({
      spreadsheetId, range: `${title}!A1`, valueInputOption: 'RAW', requestBody: { values: [headers] },
    });
  }
}

const d = (iso) => (iso ? iso.slice(0, 10) : '');
const yes = (v) => (v ? 'Yes' : '');

function pipelineRow(inf) {
  return [
    inf.handle, inf.profile_url, inf.platform, inf.followers ?? '', (inf.bio || '').slice(0, 200), inf.category || '',
    inf.score ?? '', inf.why || '', inf.external_url || '', inf.draft_dm || '',
    yes(inf.warmup_done_at), yes(inf.warmup_done_at), yes(inf.touches_sent >= 1), yes(inf.replied_at), inf.notes || '', d(inf.discovered_at),
    inf.status, inf.email || '', inf.recommended_fee ?? '', inf.agreed_fee ?? '', d(inf.approved_at), d(inf.warmup_done_at),
    inf.touches_sent ?? 0, d(inf.last_touch_at), d(inf.next_touch_at), d(inf.replied_at), inf.outcome || '', inf.batch_id ?? '',
    new Date().toISOString(),
  ];
}

async function mirror() {
  if (!isConfigured()) return { skipped: 'not configured' };
  const spreadsheetId = process.env.OUTREACH_SHEET_ID;
  const sheets = sheetsClient();
  const sb = getServiceClient();

  await ensureTab(sheets, spreadsheetId, 'Pipeline', PIPELINE_HEADERS);
  await ensureTab(sheets, spreadsheetId, 'Touches', TOUCH_HEADERS);
  await ensureTab(sheets, spreadsheetId, 'Runs', RUN_HEADERS);

  // Pipeline: upsert every creator by handle (column A).
  const { data: influencers, error } = await sb.from('influencers').select('*').order('discovered_at', { ascending: false });
  if (error) throw error;
  const { data: existing } = await sheets.spreadsheets.values.get({ spreadsheetId, range: 'Pipeline!A2:A' });
  const rowByHandle = new Map((existing.values || []).map((r, i) => [r[0], i + 2]));

  const updates = [];
  const appends = [];
  for (const inf of influencers) {
    const row = pipelineRow(inf);
    const rowNum = rowByHandle.get(inf.handle);
    if (rowNum) updates.push({ range: `Pipeline!A${rowNum}`, values: [row] });
    else appends.push(row);
  }
  if (updates.length) {
    await sheets.spreadsheets.values.batchUpdate({ spreadsheetId, requestBody: { valueInputOption: 'RAW', data: updates } });
  }
  if (appends.length) {
    await sheets.spreadsheets.values.append({
      spreadsheetId, range: 'Pipeline!A2', valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS', requestBody: { values: appends },
    });
  }

  // Touches: append anything sent since the last mirrored touch.
  const { data: touchRows } = await sheets.spreadsheets.values.get({ spreadsheetId, range: 'Touches!G2:G' });
  const knownIds = new Set((touchRows.values || []).map((r) => r[0]).filter(Boolean));
  const { data: touches } = await sb.from('influencer_touches').select('*, influencers(handle)').not('sent_at', 'is', null).order('sent_at');
  const newTouches = (touches || []).filter((t) => !knownIds.has(t.message_id || t.id)).map((t) => [
    t.sent_at, t.influencers?.handle || '', t.step, t.channel, t.sent_by || '', t.subject || '', t.message_id || t.id,
  ]);
  if (newTouches.length) {
    await sheets.spreadsheets.values.append({
      spreadsheetId, range: 'Touches!A2', valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS', requestBody: { values: newTouches },
    });
  }

  // Runs: append runs newer than the last row.
  const { data: runRows } = await sheets.spreadsheets.values.get({ spreadsheetId, range: 'Runs!A2:A' });
  const lastStarted = (runRows.values || []).map((r) => r[0]).filter(Boolean).sort().pop();
  let runsQuery = sb.from('influencer_runs').select('*').order('started_at');
  if (lastStarted) runsQuery = runsQuery.gt('started_at', lastStarted);
  const { data: runs } = await runsQuery;
  const newRuns = (runs || []).map((r) => [r.started_at, r.platform || '', (r.hashtags || []).join(' '), r.candidates, r.added, r.apify_runs, r.error || '']);
  if (newRuns.length) {
    await sheets.spreadsheets.values.append({
      spreadsheetId, range: 'Runs!A2', valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS', requestBody: { values: newRuns },
    });
  }

  return { pipelineUpdated: updates.length, pipelineAppended: appends.length, touches: newTouches.length, runs: newRuns.length };
}

module.exports = { mirror, isConfigured };
