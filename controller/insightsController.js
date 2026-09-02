const insightsService = require('../services/insightsService');
const subscriptionService = require('../services/subscriptionService');
const { ALLOWED_DAYS } = require('../services/insightsConstants');

// The one range free users may request. 30/90 (and deltas, trend) are premium.
const FREE_DAYS = 7;

const insightsController = {
  // GET /api/insights?days=7|30|90
  async getInsights(req, res) {
    const requestId = Math.random().toString(36).substring(7);
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ success: false, error: 'Authentication required', requestId });

      const parsed = parseInt(req.query.days, 10);
      const days = ALLOWED_DAYS.includes(parsed) ? parsed : FREE_DAYS;

      // Tier check inline (not requirePremium): the gate is per-range. Fail
      // CLOSED to free — a Supabase blip must not hand out 90-day data, but
      // it also must not 500 the free 7-day view.
      let tier = 'free';
      try {
        const sub = await subscriptionService.getUserSubscription(userId);
        tier = sub?.tier || 'free';
      } catch (error) {
        console.warn(`[Insights] [${requestId}] subscription lookup failed, treating as free:`, error.message);
      }
      const isPremium = tier === 'premium' || tier === 'grandfathered';

      if (days !== FREE_DAYS && !isPremium) {
        // Same body shape as middleware/checkLimits.requirePremium so the
        // client keeps one branch.
        return res.status(402).json({
          error: 'PREMIUM_REQUIRED',
          message: 'Longer ranges require a premium subscription',
          tier: 'free',
          upgradeRequired: true,
          premiumFeature: true,
        });
      }

      const data = await insightsService.getInsights(userId, days, { tier, isPremium });
      res.set('Cache-Control', 'no-store');
      res.json({ success: true, data, requestId });
    } catch (error) {
      console.error(`💥 [${requestId}] Insights failed:`, error);
      res.status(500).json({ success: false, error: 'Failed to load insights', requestId });
    }
  },
};

module.exports = insightsController;
