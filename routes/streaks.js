const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/auth');
const streakService = require('../services/streakService');

const requestMeta = () => ({
  requestId: Math.random().toString(36).substring(7),
  timestamp: new Date().toISOString()
});

// GET /api/streaks - current streak state + today's status + pending milestones
router.get('/', authMiddleware.authenticateToken, async (req, res) => {
  const meta = requestMeta();
  try {
    const userId = req.user?.userId || req.user?.id;
    const streak = await streakService.getStreak(userId);

    res.json({ success: true, streak, ...meta });
  } catch (error) {
    console.error('[Streaks] Get streak error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch streak', ...meta });
  }
});

// GET /api/streaks/calendar?start_date=YYYY-MM-DD&end_date=YYYY-MM-DD
// Available to all tiers — the chain visual drives the habit loop (decision 2026-07-10)
router.get('/calendar', authMiddleware.authenticateToken, async (req, res) => {
  const meta = requestMeta();
  try {
    const userId = req.user?.userId || req.user?.id;
    const { start_date: startDate, end_date: endDate } = req.query;

    if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate || '') || !/^\d{4}-\d{2}-\d{2}$/.test(endDate || '')) {
      return res.status(400).json({ success: false, error: 'start_date and end_date (YYYY-MM-DD) are required', ...meta });
    }

    const days = await streakService.getCalendar(userId, startDate, endDate);
    res.json({ success: true, days, ...meta });
  } catch (error) {
    console.error('[Streaks] Get calendar error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch streak calendar', ...meta });
  }
});

// GET /api/streaks/milestones - all achieved milestones (badge history)
router.get('/milestones', authMiddleware.authenticateToken, async (req, res) => {
  const meta = requestMeta();
  try {
    const userId = req.user?.userId || req.user?.id;
    const milestones = await streakService.getMilestones(userId);

    res.json({ success: true, milestones, ...meta });
  } catch (error) {
    console.error('[Streaks] Get milestones error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch milestones', ...meta });
  }
});

// POST /api/streaks/milestones/:id/dismiss - dismiss a milestone celebration
router.post('/milestones/:id/dismiss', authMiddleware.authenticateToken, async (req, res) => {
  const meta = requestMeta();
  try {
    const userId = req.user?.userId || req.user?.id;
    const dismissed = await streakService.dismissMilestone(userId, req.params.id);

    if (!dismissed) {
      return res.status(404).json({ success: false, error: 'Milestone not found', ...meta });
    }

    res.json({ success: true, milestone: dismissed, ...meta });
  } catch (error) {
    console.error('[Streaks] Dismiss milestone error:', error);
    res.status(500).json({ success: false, error: 'Failed to dismiss milestone', ...meta });
  }
});

module.exports = router;
