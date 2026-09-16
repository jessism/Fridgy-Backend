/**
 * Admin influencer outreach API — backs trackabite.app/admin/influencers.
 * Every route: authenticated + users.is_admin.
 *
 * Rows come from trackabite-outreach (discovery). This router owns every
 * state change after that: approve / hold / reject, warm-up done (sends the
 * first email), DM sent, replied / signed / declined, draft edits, and the
 * manual triggers for the cron jobs so the flow can be exercised by hand.
 *
 * Plan: trackabite-mobile/MD_files/PLAN_INFLUENCER_AGENT_SPT13.md
 */
const express = require('express');
const { authenticateToken } = require('../middleware/auth');
const { requireAdmin } = require('../middleware/adminAuth');
const { getServiceClient } = require('../config/supabase');
const config = require('../services/influencerOutreach/config');
const sm = require('../services/influencerOutreach/stateMachine');
const { retryEmailTouch } = require('../services/influencerOutreach/sendTouch');
const scheduler = require('../services/influencerOutreach/scheduler');
const mailer = require('../services/influencerOutreach/mailer');

const router = express.Router();
router.use(authenticateToken, requireAdmin);

const STATUSES = [
  'pending_approval', 'warmup_needed', 'dm_needed', 'contacted', 'followup_needed',
  'replied', 'signed', 'declined', 'no_response', 'rejected', 'hold', 'opted_out', 'bounced',
];
const EDITABLE = ['draft_dm', 'draft_email_subject', 'draft_email', 'notes', 'hold_note', 'agreed_fee', 'email', 'promo_code', 'tracking_link', 'rejection_reason'];

const fail = (res, e, fallback) => {
  const status = e.status || 500;
  if (status >= 500) console.error('[AdminInfluencers]', fallback, e.message);
  res.status(status).json({ success: false, error: status >= 500 ? fallback : e.message });
};

/** Counts per status + the open batch + what's due tonight. */
router.get('/today', async (req, res) => {
  try {
    const sb = getServiceClient();
    const [{ data: statusRows, error: e1 }, batch] = await Promise.all([
      sb.from('influencers').select('status'),
      sm.currentOpenBatch(false),
    ]);
    if (e1) throw e1;
    const counts = {};
    for (const r of statusRows || []) counts[r.status] = (counts[r.status] || 0) + 1;

    let batchCreators = [];
    if (batch) {
      const { data, error } = await sb
        .from('influencers')
        .select('*, influencer_posts(*)')
        .eq('batch_id', batch.id)
        .order('approved_at');
      if (error) throw error;
      batchCreators = data;
    }

    const { data: dmTouches, error: e3 } = await sb
      .from('influencer_touches')
      .select('*, influencers!inner(id, handle, platform, profile_url, display_name, status, email, email_error)')
      .eq('channel', 'dm')
      .is('sent_at', null)
      .order('created_at');
    if (e3) throw e3;

    const since = new Date(Date.now() - 7 * 86400000).toISOString();
    const { data: replies, error: e4 } = await sb
      .from('influencers')
      .select('id, handle, platform, profile_url, replied_at, reply_channel, status, email')
      .in('status', ['replied'])
      .gte('replied_at', since)
      .order('replied_at', { ascending: false });
    if (e4) throw e4;

    const { data: failedEmails } = await sb
      .from('influencer_touches')
      .select('id, step, error, influencer_id, influencers!inner(handle)')
      .eq('channel', 'email').is('sent_at', null).not('error', 'is', null);

    res.json({
      success: true,
      data: {
        counts,
        batch: batch ? { ...batch, creators: batchCreators } : null,
        dmTasks: dmTouches.filter((t) => ['dm_needed', 'followup_needed'].includes(t.influencers.status)),
        replies,
        failedEmails: failedEmails || [],
        config: {
          batchSize: config.batchSize, warmupLikes: config.warmupLikes, warmupComments: config.warmupComments,
          followupsDays: config.followupsDays, dmOnTouches: config.dmOnTouches,
          emailEnabled: mailer.isEnabled(), emailConfigured: mailer.isConfigured(),
        },
      },
    });
  } catch (e) {
    fail(res, e, 'Failed to load today');
  }
});

router.get('/', async (req, res) => {
  try {
    const sb = getServiceClient();
    let q = sb
      .from('influencers')
      .select('id, batch_id, platform, handle, profile_url, display_name, followers, engagement_rate, email, category, score, why, recommended_fee, agreed_fee, other_platforms, status, discovered_at, approved_at, contacted_at, next_touch_at, touches_sent, replied_at, email_error, draft_dm, rejection_reason')
      .order('discovered_at', { ascending: false })
      .limit(500);
    const status = String(req.query.status || '');
    if (status && STATUSES.includes(status)) q = q.eq('status', status);
    else if (status === 'in_progress') q = q.in('status', ['warmup_needed', 'dm_needed', 'contacted', 'followup_needed']);
    const { data, error } = await q;
    if (error) throw error;
    res.json({ success: true, data });
  } catch (e) {
    fail(res, e, 'Failed to load influencers');
  }
});

router.get('/:id', async (req, res) => {
  try {
    const sb = getServiceClient();
    const { data, error } = await sb
      .from('influencers')
      .select('*, influencer_posts(*), influencer_touches(*)')
      .eq('id', req.params.id)
      .maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ success: false, error: 'Not found' });
    data.influencer_posts.sort((a, b) => (b.posted_at || '').localeCompare(a.posted_at || ''));
    data.influencer_touches.sort((a, b) => a.step - b.step || a.channel.localeCompare(b.channel));
    res.json({ success: true, data });
  } catch (e) {
    fail(res, e, 'Failed to load influencer');
  }
});

/** Draft edits, notes, fee, and the simple status moves. */
router.patch('/:id', async (req, res) => {
  try {
    const body = req.body || {};
    const id = req.params.id;
    const patch = {};
    for (const k of EDITABLE) {
      if (body[k] !== undefined) patch[k] = body[k] === '' ? null : body[k];
    }
    if (patch.agreed_fee != null) {
      const n = parseInt(patch.agreed_fee, 10);
      if (!Number.isInteger(n) || n < 0) return res.status(400).json({ success: false, error: 'agreed_fee must be a whole number' });
      patch.agreed_fee = n;
    }

    let result = null;
    if (body.status) {
      switch (body.status) {
        case 'warmup_needed': result = await sm.approve(id); break;
        case 'hold': result = await sm.hold(id, body.hold_note); break;
        case 'rejected': result = await sm.reject(id, body.rejection_reason); break;
        case 'replied': result = await sm.markReplied(id, body.reply_channel || 'dm'); break;
        case 'signed':
        case 'declined':
        case 'opted_out':
          result = await sm.update(id, { status: body.status, outcome: body.status, next_touch_at: null }); break;
        case 'pending_approval':
          result = await sm.update(id, { status: 'pending_approval', batch_id: null, approved_at: null }); break;
        default:
          return res.status(400).json({ success: false, error: `Status ${body.status} cannot be set directly` });
      }
    }
    if (Object.keys(patch).length) result = await sm.update(id, patch);
    if (!result) return res.status(400).json({ success: false, error: 'Nothing to update' });
    res.json({ success: true, data: result });
  } catch (e) {
    fail(res, e, 'Failed to update influencer');
  }
});

router.post('/:id/warmup-done', async (req, res) => {
  try {
    res.json({ success: true, data: await sm.warmupDone(req.params.id) });
  } catch (e) {
    fail(res, e, 'Failed to finish warm-up');
  }
});

router.post('/batches/:batchId/warmup-done', async (req, res) => {
  try {
    res.json({ success: true, data: await sm.batchWarmupDone(parseInt(req.params.batchId, 10)) });
  } catch (e) {
    fail(res, e, 'Failed to finish batch warm-up');
  }
});

router.post('/:id/dm-sent', async (req, res) => {
  try {
    res.json({ success: true, data: await sm.dmSent(req.params.id) });
  } catch (e) {
    fail(res, e, 'Failed to record DM');
  }
});

/** Like / comment progress ticks on a warm-up post. */
router.post('/:id/posts/:postId', async (req, res) => {
  try {
    const sb = getServiceClient();
    const patch = {};
    if (req.body.liked !== undefined) patch.liked_at = req.body.liked ? new Date().toISOString() : null;
    if (req.body.commented !== undefined) patch.commented_at = req.body.commented ? new Date().toISOString() : null;
    const { data, error } = await sb.from('influencer_posts').update(patch)
      .eq('id', req.params.postId).eq('influencer_id', req.params.id).select('*').maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ success: false, error: 'Post not found' });
    res.json({ success: true, data });
  } catch (e) {
    fail(res, e, 'Failed to update post');
  }
});

router.post('/touches/:touchId/retry', async (req, res) => {
  try {
    const sb = getServiceClient();
    const { data: touch, error } = await sb.from('influencer_touches').select('*, influencers(*)').eq('id', req.params.touchId).maybeSingle();
    if (error) throw error;
    if (!touch) return res.status(404).json({ success: false, error: 'Touch not found' });
    const data = await retryEmailTouch(touch, touch.influencers);
    res.json({ success: true, data });
  } catch (e) {
    fail(res, e, 'Retry failed');
  }
});

/** Manual triggers for the cron jobs, so the whole flow can be run by hand. */
router.post('/jobs/:job', async (req, res) => {
  const jobs = {
    followups: () => scheduler.runFollowups(),
    retries: () => scheduler.retryFailedEmails(),
    digest: () => scheduler.sendDigest(),
    scan: () => scheduler.scan(),
    mirror: () => scheduler.mirror(),
  };
  const job = jobs[req.params.job];
  if (!job) return res.status(404).json({ success: false, error: 'Unknown job' });
  try {
    res.json({ success: true, data: (await job()) ?? { ok: true } });
  } catch (e) {
    fail(res, e, `Job ${req.params.job} failed`);
  }
});

module.exports = router;
