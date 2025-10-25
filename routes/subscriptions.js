/**
 * Subscription Routes
 * API endpoints for subscription management
 */

const express = require('express');
const router = express.Router();
const subscriptionController = require('../controller/subscriptionController');
const { authenticateToken } = require('../middleware/auth');

// All subscription routes require authentication
router.use(authenticateToken);

/**
 * GET /api/subscriptions/status
 * Get user's subscription status and usage statistics
 */
router.get('/status', subscriptionController.getStatus);

/**
 * POST /api/subscriptions/create-checkout
 * Create Stripe Checkout session to start trial/subscription
 * Body: { promoCode?: string }
 */
router.post('/create-checkout', subscriptionController.createCheckout);

/**
 * POST /api/subscriptions/create-portal-session
 * Create Stripe Customer Portal session for billing management
 */
router.post('/create-portal-session', subscriptionController.createPortalSession);

/**
 * POST /api/subscriptions/cancel
 * Cancel subscription (access remains until end of billing period)
 */
router.post('/cancel', subscriptionController.cancelSubscription);

/**
 * POST /api/subscriptions/reactivate
 * Reactivate a canceled subscription (undo cancellation before period ends)
 */
router.post('/reactivate', subscriptionController.reactivateSubscription);

/**
 * POST /api/subscriptions/validate-promo
 * Validate a promo code
 * Body: { code: string }
 */
router.post('/validate-promo', subscriptionController.validatePromoCode);

/**
 * POST /api/subscriptions/apply-promo
 * Apply promo code to existing subscription
 * Body: { code: string }
 */
router.post('/apply-promo', subscriptionController.applyPromoCode);

module.exports = router;
