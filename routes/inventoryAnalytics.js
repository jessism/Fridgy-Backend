const express = require('express');
const inventoryAnalyticsController = require('../controller/inventoryAnalyticsController');
const { authenticateToken } = require('../middleware/auth');
const { requirePremium } = require('../middleware/checkLimits');

const router = express.Router();

// Health check endpoint to verify analytics route is working
router.get('/health', (req, res) => {
  res.json({
    success: true,
    message: 'Inventory Analytics API is working!',
    timestamp: new Date().toISOString(),
    endpoint: '/api/inventory-analytics/health'
  });
});

// Debug endpoint to check authentication and basic data (PREMIUM ONLY)
router.get('/debug', authenticateToken, requirePremium, inventoryAnalyticsController.debugAnalytics);

// Get inventory usage analytics for authenticated user (PREMIUM ONLY)
// Supports query parameter: ?days=30 (7, 30, or 90)
router.get('/usage', authenticateToken, requirePremium, inventoryAnalyticsController.getUsageAnalytics);

module.exports = router;