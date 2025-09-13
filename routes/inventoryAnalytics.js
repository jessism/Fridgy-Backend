const express = require('express');
const inventoryAnalyticsController = require('../controller/inventoryAnalyticsController');
const { authenticateToken } = require('../middleware/auth');

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

// Debug endpoint to check authentication and basic data
router.get('/debug', authenticateToken, inventoryAnalyticsController.debugAnalytics);

// Get inventory usage analytics for authenticated user
// Supports query parameter: ?days=30 (7, 30, or 90)
router.get('/usage', authenticateToken, inventoryAnalyticsController.getUsageAnalytics);

module.exports = router;