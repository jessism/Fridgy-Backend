/**
 * Subscription Routes
 * API endpoints for subscription management
 */

const express = require('express');
const router = express.Router();
const subscriptionController = require('../controller/subscriptionController');
const { authenticateToken } = require('../middleware/auth');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

// Cache for price data (5 minute TTL)
let priceCache = null;
let priceCacheTime = 0;
const PRICE_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

/**
 * GET /api/subscriptions/price
 * Get subscription price from Stripe (PUBLIC - no auth required)
 * Returns: { price: number, formatted: string, interval: string }
 */
router.get('/price', async (req, res) => {
  try {
    const now = Date.now();

    // Return cached price if still valid
    if (priceCache && (now - priceCacheTime) < PRICE_CACHE_TTL) {
      return res.json(priceCache);
    }

    // Fetch price from Stripe
    const priceId = process.env.STRIPE_PRICE_ID;
    if (!priceId) {
      return res.status(500).json({ error: 'Price ID not configured' });
    }

    const price = await stripe.prices.retrieve(priceId);

    // Format the price
    const amount = price.unit_amount / 100; // Convert cents to dollars
    const formatted = `$${amount.toFixed(2)}`;
    const interval = price.recurring?.interval || 'month';

    // Cache the result
    priceCache = {
      price: price.unit_amount,
      amount,
      formatted,
      interval,
      formattedWithInterval: `${formatted}/${interval}`
    };
    priceCacheTime = now;

    res.json(priceCache);
  } catch (error) {
    console.error('Error fetching price from Stripe:', error);
    // Return fallback price if Stripe fails
    res.json({
      price: 333,
      amount: 3.33,
      formatted: '$3.33',
      interval: 'month',
      formattedWithInterval: '$3.33/month'
    });
  }
});

// All other subscription routes require authentication
router.use(authenticateToken);

/**
 * GET /api/subscriptions/status
 * Get user's subscription status and usage statistics
 */
router.get('/status', subscriptionController.getStatus);

/**
 * POST /api/subscriptions/create-checkout
 * Create Stripe Checkout session to start trial/subscription (DEPRECATED - use create-subscription-intent)
 * Body: { promoCode?: string }
 */
router.post('/create-checkout', subscriptionController.createCheckout);

/**
 * POST /api/subscriptions/create-subscription-intent
 * Create Stripe Subscription Intent for Payment Element (NEW - recommended)
 * Body: { promoCode?: string }
 */
router.post('/create-subscription-intent', subscriptionController.createSubscriptionIntent);

/**
 * POST /api/subscriptions/confirm-subscription
 * Confirm subscription after successful payment (immediate activation)
 * Body: { paymentIntentId: string, subscriptionId: string }
 */
router.post('/confirm-subscription', subscriptionController.confirmSubscription);

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
