/**
 * Admin analytics API — backs trackabite.app/admin/analytics.
 * Every route: authenticated + users.is_admin. Read-only.
 */
const express = require('express');
const { authenticateToken } = require('../middleware/auth');
const { requireAdmin } = require('../middleware/adminAuth');
const adminAnalyticsService = require('../services/adminAnalyticsService');

const router = express.Router();
router.use(authenticateToken, requireAdmin);

const clampDays = (v) => Math.min(365, Math.max(1, parseInt(v, 10) || 30));

router.get('/overview', async (req, res) => {
  try {
    const data = await adminAnalyticsService.getOverview({ days: clampDays(req.query.days) });
    res.json({ success: true, data });
  } catch (error) {
    console.error('[AdminAnalytics] overview failed:', error.message);
    res.status(500).json({ success: false, error: 'Failed to load overview' });
  }
});

router.get('/users', async (req, res) => {
  try {
    const data = await adminAnalyticsService.listUsers({
      search: String(req.query.search || ''),
      sort: String(req.query.sort || 'created_at'),
      dir: req.query.dir === 'asc' ? 'asc' : 'desc',
      page: Math.max(1, parseInt(req.query.page, 10) || 1),
      pageSize: Math.min(200, Math.max(1, parseInt(req.query.pageSize, 10) || 50)),
    });
    res.json({ success: true, data });
  } catch (error) {
    console.error('[AdminAnalytics] users failed:', error.message);
    res.status(500).json({ success: false, error: 'Failed to load users' });
  }
});

router.get('/users/:id', async (req, res) => {
  try {
    const data = await adminAnalyticsService.getUserDetail(req.params.id);
    if (!data) return res.status(404).json({ success: false, error: 'User not found' });
    res.json({ success: true, data });
  } catch (error) {
    console.error('[AdminAnalytics] user detail failed:', error.message);
    res.status(500).json({ success: false, error: 'Failed to load user' });
  }
});

module.exports = router;
