/**
 * Admin Reddit opportunities API — backs trackabite.app/admin/reddit.
 * Every route: authenticated + users.is_admin.
 *
 * Rows come from services/redditOpportunities (F5Bot email ingest + LLM
 * scoring on a cron). This router owns what happens after: mark replied or
 * dismissed, notes, on-demand reply drafts, template CRUD, and manual job
 * triggers so the flow can be exercised by hand.
 *
 * Plan: trackabite-mobile/MD_files/PLAN_REDDIT_ALERT_OCT10.md
 */
const express = require('express');
const { authenticateToken } = require('../middleware/auth');
const { requireAdmin } = require('../middleware/adminAuth');
const { getServiceClient } = require('../config/supabase');
const config = require('../services/redditOpportunities/config');
const scheduler = require('../services/redditOpportunities/scheduler');
const { draftReply } = require('../services/redditOpportunities/score');

const router = express.Router();
router.use(authenticateToken, requireAdmin);

const STATUSES = ['new', 'replied', 'dismissed', 'filtered'];

const fail = (res, e, fallback) => {
  const status = e.status || 500;
  if (status >= 500) console.error('[AdminReddit]', fallback, e.message);
  res.status(status).json({ success: false, error: status >= 500 ? fallback : e.message });
};

/** Counts for the header tiles. */
router.get('/stats', async (req, res) => {
  try {
    const sb = getServiceClient();
    const { data: rows, error } = await sb
      .from('reddit_opportunities')
      .select('status, score, created_at, keyword');
    if (error) throw error;
    const weekAgo = Date.now() - 7 * 86400000;

    // Per-keyword scoreboard: F5Bot keywords are hypotheses, this is the
    // measurement — swap the worst performer on f5bot.com, no deploy needed.
    const byKeyword = new Map();
    for (const r of rows) {
      const k = r.keyword || '(unknown)';
      const e = byKeyword.get(k) || { keyword: k, hits: 0, kept: 0, scoreSum: 0, scored: 0 };
      e.hits += 1;
      if (r.status !== 'filtered') e.kept += 1;
      if (r.score !== null) { e.scored += 1; e.scoreSum += r.score; }
      byKeyword.set(k, e);
    }
    const keywords = [...byKeyword.values()]
      .map(({ scoreSum, scored, ...e }) => ({ ...e, avgScore: scored ? Math.round(scoreSum / scored) : null }))
      .sort((a, b) => b.hits - a.hits);

    res.json({
      success: true,
      data: {
        counts: STATUSES.reduce((acc, s) => ({ ...acc, [s]: rows.filter((r) => r.status === s).length }), {}),
        thisWeek: rows.filter((r) => new Date(r.created_at).getTime() >= weekAgo && r.status !== 'filtered').length,
        unscored: rows.filter((r) => r.score === null).length,
        keywords,
        config: { keepScore: config.keepScore, alertScore: config.alertScore, mailbox: config.alertMailbox },
      },
    });
  } catch (e) {
    fail(res, e, 'Failed to load stats');
  }
});

router.get('/opportunities', async (req, res) => {
  try {
    const sb = getServiceClient();
    let q = sb
      .from('reddit_opportunities')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(200);
    const status = String(req.query.status || '');
    if (STATUSES.includes(status)) q = q.eq('status', status);
    else if (status !== 'all') q = q.neq('status', 'filtered'); // default view hides the noise
    const minScore = parseInt(req.query.min_score, 10);
    if (Number.isInteger(minScore)) q = q.gte('score', minScore);
    const { data, error } = await q;
    if (error) throw error;
    res.json({ success: true, data });
  } catch (e) {
    fail(res, e, 'Failed to load opportunities');
  }
});

/** Status moves (replied / dismissed / back to new) and notes. */
router.patch('/opportunities/:id', async (req, res) => {
  try {
    const patch = {};
    if (req.body.status !== undefined) {
      if (!['new', 'replied', 'dismissed'].includes(req.body.status)) {
        return res.status(400).json({ success: false, error: `Status ${req.body.status} cannot be set directly` });
      }
      patch.status = req.body.status;
    }
    if (req.body.notes !== undefined) patch.notes = req.body.notes === '' ? null : String(req.body.notes).slice(0, 2000);
    if (!Object.keys(patch).length) return res.status(400).json({ success: false, error: 'Nothing to update' });

    const sb = getServiceClient();
    const { data, error } = await sb
      .from('reddit_opportunities').update(patch).eq('id', req.params.id).select('*').maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ success: false, error: 'Not found' });
    res.json({ success: true, data });
  } catch (e) {
    fail(res, e, 'Failed to update opportunity');
  }
});

/** Draft (or re-draft) the reply for one opportunity, whatever its score. */
router.post('/opportunities/:id/draft', async (req, res) => {
  try {
    res.json({ success: true, data: await draftReply(req.params.id) });
  } catch (e) {
    fail(res, e, 'Failed to draft a reply');
  }
});

// ── Templates ──
router.get('/templates', async (req, res) => {
  try {
    const sb = getServiceClient();
    const { data, error } = await sb.from('reddit_reply_templates').select('*').order('sort').order('created_at');
    if (error) throw error;
    res.json({ success: true, data });
  } catch (e) {
    fail(res, e, 'Failed to load templates');
  }
});

router.post('/templates', async (req, res) => {
  try {
    const { name, category, body, sort } = req.body || {};
    if (!name || !body) return res.status(400).json({ success: false, error: 'name and body are required' });
    const sb = getServiceClient();
    const { data, error } = await sb
      .from('reddit_reply_templates')
      .insert({ name: String(name).slice(0, 120), category: category || null, body: String(body).slice(0, 8000), sort: parseInt(sort, 10) || 0 })
      .select('*')
      .single();
    if (error) throw error;
    res.json({ success: true, data });
  } catch (e) {
    fail(res, e, 'Failed to create template');
  }
});

router.patch('/templates/:id', async (req, res) => {
  try {
    const patch = {};
    for (const k of ['name', 'category', 'body']) {
      if (req.body[k] !== undefined) patch[k] = req.body[k] === '' ? null : String(req.body[k]).slice(0, k === 'body' ? 8000 : 120);
    }
    if (req.body.sort !== undefined) patch.sort = parseInt(req.body.sort, 10) || 0;
    if (!Object.keys(patch).length) return res.status(400).json({ success: false, error: 'Nothing to update' });
    const sb = getServiceClient();
    const { data, error } = await sb
      .from('reddit_reply_templates').update(patch).eq('id', req.params.id).select('*').maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ success: false, error: 'Not found' });
    res.json({ success: true, data });
  } catch (e) {
    fail(res, e, 'Failed to update template');
  }
});

router.delete('/templates/:id', async (req, res) => {
  try {
    const sb = getServiceClient();
    const { error } = await sb.from('reddit_reply_templates').delete().eq('id', req.params.id);
    if (error) throw error;
    res.json({ success: true, data: { deleted: true } });
  } catch (e) {
    fail(res, e, 'Failed to delete template');
  }
});

/** Manual triggers for the cron jobs, so the whole flow can be run by hand. */
router.post('/jobs/:job', async (req, res) => {
  const jobs = {
    ingest: () => scheduler.runIngestCycle(),
    digest: () => scheduler.sendDigest(),
  };
  const job = jobs[req.params.job];
  if (!job) return res.status(404).json({ success: false, error: 'Unknown job' });
  try {
    res.json({ success: true, data: (await job()) ?? { ok: true } });
  } catch (e) {
    console.error(`[AdminReddit] job ${req.params.job} failed:`, e.message);
    res.status(502).json({ success: false, error: `${req.params.job}: ${e.message}` });
  }
});

module.exports = router;
