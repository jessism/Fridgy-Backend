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
const { sendPreparedTouch } = require('../services/influencerOutreach/sendTouch');
const scheduler = require('../services/influencerOutreach/scheduler');
const mailer = require('../services/influencerOutreach/mailer');

const router = express.Router();
router.use(authenticateToken, requireAdmin);

const STATUSES = [
  'pending_approval', 'warmup_needed', 'dm_needed', 'contacted', 'followup_needed',
  'replied', 'signed', 'declined', 'no_response', 'rejected', 'hold', 'opted_out', 'bounced', 'removed',
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
    const [{ data: statusRows, error: e1 }, batches] = await Promise.all([
      sb.from('influencers').select('status'),
      sm.openBatches(),
    ]);
    if (e1) throw e1;
    const counts = {};
    for (const r of statusRows || []) counts[r.status] = (counts[r.status] || 0) + 1;

    // Every open batch, each with its creators. More than one exists whenever a
    // batch approved in an earlier session has not been closed yet; the UI shows
    // those separately from the one being approved into today.
    let batchesWithCreators = [];
    if (batches.length) {
      const { data, error } = await sb
        .from('influencers')
        .select('*, influencer_posts(*)')
        .in('batch_id', batches.map((b) => b.id))
        .order('approved_at');
      if (error) throw error;
      batchesWithCreators = batches.map((b) => ({
        ...b,
        opened_today: sm.openedToday(b),
        creators: data.filter((c) => c.batch_id === b.id),
      }));
    }
    const batch = batchesWithCreators[batchesWithCreators.length - 1] || null;

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

    // Emails drafted and waiting for Send (plus any that failed), newest last.
    const { data: emailTouches, error: e5 } = await sb
      .from('influencer_touches')
      .select('*, influencers!inner(id, handle, platform, profile_url, display_name, status, email)')
      .eq('channel', 'email')
      .is('sent_at', null)
      .order('created_at');
    if (e5) throw e5;
    const emailTasks = (emailTouches || []).filter((t) =>
      ['dm_needed', 'contacted', 'followup_needed'].includes(t.influencers.status));

    res.json({
      success: true,
      data: {
        counts,
        batch,
        batches: batchesWithCreators,
        dmTasks: dmTouches.filter((t) => ['dm_needed', 'followup_needed'].includes(t.influencers.status)),
        emailTasks,
        replies,
        config: {
          batchSize: config.batchSize, warmupLikes: config.warmupLikes, warmupComments: config.warmupComments,
          followupsDays: config.followupsDays, dmOnTouches: config.dmOnTouches,
          emailEnabled: mailer.isEnabled(), emailConfigured: mailer.isConfigured(), emailReason: mailer.statusReason(),
          fromName: config.fromName, fromEmail: process.env.GMAIL_SENDER || null,
          sheetUrl: config.sheetUrl,
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

    // Which channels actually reached each creator, so "contacted" can say
    // whether that was a DM, an email, or both.
    if (data.length) {
      const { data: sent, error: e2 } = await sb
        .from('influencer_touches')
        .select('influencer_id, channel')
        .in('influencer_id', data.map((r) => r.id))
        .not('sent_at', 'is', null);
      if (e2) throw e2;
      const byInfluencer = new Map();
      for (const t of sent || []) {
        if (!byInfluencer.has(t.influencer_id)) byInfluencer.set(t.influencer_id, new Set());
        byInfluencer.get(t.influencer_id).add(t.channel);
      }
      for (const row of data) {
        row.channelsSent = [...(byInfluencer.get(row.id) || [])].sort();
      }
    }

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
        case 'removed': result = await sm.removeFromPipeline(id, body.rejection_reason); break;
        case 'restore': result = await sm.restore(id); break;
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

/**
 * Edit a drafted email before it goes out. Only the pending touch is editable —
 * a sent message is history. This is what Send actually transmits, so edits
 * here (not the creator's template fields) are what reach the creator.
 */
router.patch('/touches/:touchId', async (req, res) => {
  try {
    const sb = getServiceClient();
    const { data: touch, error } = await sb
      .from('influencer_touches')
      .select('id, sent_at, channel')
      .eq('id', req.params.touchId)
      .maybeSingle();
    if (error) throw error;
    if (!touch) return res.status(404).json({ success: false, error: 'Touch not found' });
    if (touch.sent_at) return res.status(409).json({ success: false, error: 'That message was already sent' });

    const patch = { edited: true };
    if (req.body.subject !== undefined) patch.subject = String(req.body.subject).slice(0, 300);
    if (req.body.body !== undefined) patch.body = String(req.body.body).slice(0, 20000);
    if (patch.subject === undefined && patch.body === undefined) {
      return res.status(400).json({ success: false, error: 'Nothing to update' });
    }
    // A saved edit clears a previous send failure; the retry starts clean.
    patch.error = null;

    const { data, error: e2 } = await sb.from('influencer_touches').update(patch).eq('id', touch.id).select('*').single();
    if (e2) throw e2;
    res.json({ success: true, data });
  } catch (e) {
    fail(res, e, 'Failed to save the draft');
  }
});

/** Send a drafted email (or retry one that failed). Same path for both. */
const sendEmailHandler = async (req, res) => {
  try {
    res.json({ success: true, data: await sendPreparedTouch(req.params.touchId, 'human') });
  } catch (e) {
    // A delivery failure is operational information, not an internal error:
    // pass the real reason through so the dashboard can show it.
    const status = e.status || 502;
    if (!e.status) console.error('[AdminInfluencers] send failed:', e.message);
    res.status(status).json({ success: false, error: e.message });
  }
};
router.post('/touches/:touchId/send', sendEmailHandler);
router.post('/touches/:touchId/retry', sendEmailHandler);

/** Send every drafted email waiting for review, in order. */
router.post('/emails/send-all', async (req, res) => {
  try {
    const sb = getServiceClient();
    const { data: pendingEmails, error } = await sb
      .from('influencer_touches')
      .select('id, influencers!inner(status, email)')
      .eq('channel', 'email')
      .is('sent_at', null)
      .order('created_at');
    if (error) throw error;

    const results = [];
    for (const t of pendingEmails || []) {
      if (!t.influencers.email || !['dm_needed', 'contacted', 'followup_needed'].includes(t.influencers.status)) continue;
      try {
        await sendPreparedTouch(t.id, 'human');
        results.push({ id: t.id, sent: true });
      } catch (e) {
        results.push({ id: t.id, sent: false, error: e.message });
      }
    }
    res.json({ success: true, data: { sent: results.filter((r) => r.sent).length, failed: results.filter((r) => !r.sent) } });
  } catch (e) {
    fail(res, e, 'Sending the emails failed');
  }
});

/** Manual triggers for the cron jobs, so the whole flow can be run by hand. */
router.post('/jobs/:job', async (req, res) => {
  const jobs = {
    followups: () => scheduler.runFollowups(),
    digest: () => scheduler.sendDigest(),
    scan: () => scheduler.scan(),
    mirror: () => scheduler.mirror(),
  };
  const job = jobs[req.params.job];
  if (!job) return res.status(404).json({ success: false, error: 'Unknown job' });
  try {
    res.json({ success: true, data: (await job()) ?? { ok: true } });
  } catch (e) {
    // The real reason, not "Job scan failed" — that generic message is how a
    // blocked IMAP port stayed invisible for a week.
    console.error(`[AdminInfluencers] job ${req.params.job} failed:`, e.message);
    res.status(502).json({ success: false, error: `${req.params.job}: ${e.message}` });
  }
});

module.exports = router;
