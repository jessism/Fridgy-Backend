/**
 * User-facing insights — backs the mobile Insights screen.
 * 7-day window is free for every signed-in user; 30/90 return 402 for free tier
 * (decided inside the controller, not by requirePremium).
 *
 * The older GET /api/inventory-analytics/usage stays live for the web app and
 * shipped mobile builds.
 */
const express = require('express');
const { authenticateToken } = require('../middleware/auth');
const { insightsLimiter } = require('../middleware/rateLimiter');
const insightsController = require('../controller/insightsController');

const router = express.Router();

// Limiter is keyed on req.user.id, so it must run AFTER authenticateToken.
router.get('/', authenticateToken, insightsLimiter, insightsController.getInsights);

module.exports = router;
