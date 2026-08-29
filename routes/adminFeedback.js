/**
 * Admin feedback API — backs trackabite.app/admin/feedback.
 * Every route: authenticated + users.is_admin.
 *
 * Status values are the ones the table actually defines:
 * 'new' | 'read' | 'resolved' (migrations/add_feedback_submissions.sql).
 * The feedback_admin_all RLS policy on that table is not what gates this —
 * the backend connects as service_role, which bypasses RLS entirely.
 */
const express = require('express');
const { authenticateToken } = require('../middleware/auth');
const { requireAdmin } = require('../middleware/adminAuth');
const { getServiceClient } = require('../config/supabase');

const router = express.Router();
router.use(authenticateToken, requireAdmin);

const STATUSES = ['new', 'read', 'resolved'];
const ROW_COLUMNS = 'id,message,user_email,user_name,status,created_at,user_id';

const shape = (row, user) => ({
  id: row.id,
  message: row.message,
  userEmail: row.user_email,
  userName: row.user_name,
  status: row.status,
  createdAt: row.created_at,
  user: user ? { id: user.id, tier: user.tier, signupPlatform: user.signup_platform } : null,
});

router.get('/', async (req, res) => {
  try {
    const sb = getServiceClient();
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize, 10) || 50));
    const status = STATUSES.includes(req.query.status) ? req.query.status : null;
    const from = (page - 1) * pageSize;

    let q = sb
      .from('feedback_submissions')
      .select(ROW_COLUMNS, { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(from, from + pageSize - 1);
    if (status) q = q.eq('status', status);

    const { data: rows, error, count } = await q;
    if (error) throw error;

    // Join the submitter in a second query — N is one page (<= 100), so this
    // stays a single extra round trip rather than a join we'd have to maintain.
    const ids = [...new Set((rows || []).map((r) => r.user_id).filter(Boolean))];
    let usersById = {};
    if (ids.length) {
      const { data: users, error: userError } = await sb
        .from('users')
        .select('id,tier,signup_platform')
        .in('id', ids);
      if (userError) throw userError;
      usersById = Object.fromEntries((users || []).map((u) => [u.id, u]));
    }

    const items = (rows || []).map((r) => shape(r, usersById[r.user_id]));
    res.json({
      success: true,
      data: { items, total: count == null ? items.length : count, page, pageSize },
    });
  } catch (error) {
    console.error('[AdminFeedback] list failed:', error.message);
    res.status(500).json({ success: false, error: 'Failed to load feedback' });
  }
});

router.patch('/:id', async (req, res) => {
  try {
    const { status } = req.body || {};
    if (!STATUSES.includes(status)) {
      return res.status(400).json({
        success: false,
        error: `status must be one of: ${STATUSES.join(', ')}`,
      });
    }

    const sb = getServiceClient();
    const { data, error } = await sb
      .from('feedback_submissions')
      .update({ status })
      .eq('id', req.params.id)
      .select(ROW_COLUMNS)
      .maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ success: false, error: 'Feedback not found' });

    res.json({ success: true, data: shape(data, null) });
  } catch (error) {
    console.error('[AdminFeedback] update failed:', error.message);
    res.status(500).json({ success: false, error: 'Failed to update feedback' });
  }
});

module.exports = router;
