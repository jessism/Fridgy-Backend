/**
 * Webhook Routes
 * Stripe webhook endpoint
 *
 * IMPORTANT: This route must be registered BEFORE express.json() middleware
 * because Stripe signature verification requires the raw request body
 */

const express = require('express');
const router = express.Router();
const webhookController = require('../controller/webhookController');

/**
 * POST /api/webhooks/stripe
 * Stripe webhook endpoint
 *
 * Receives events from Stripe (checkout completed, subscription updated, payment failed, etc.)
 * Uses raw body parser for signature verification
 */
router.post(
  '/stripe',
  express.raw({ type: 'application/json' }),
  webhookController.handleStripeWebhook
);

/**
 * GET /api/webhooks/stripe/health
 * Health check endpoint for webhook configuration
 */
router.get('/stripe/health', webhookController.healthCheck);

/**
 * POST /api/webhooks/revenuecat
 * RevenueCat webhook endpoint
 *
 * Receives events from RevenueCat (purchases, renewals, cancellations, expirations)
 * Uses JSON body parser (added here because this route is registered before global express.json())
 *
 * Note: Unlike Stripe, RevenueCat doesn't require raw body for signature verification
 * Authentication happens via Authorization header check
 */
router.post(
  '/revenuecat',
  express.json(),  // Parse JSON body for this route
  webhookController.handleRevenueCatWebhook
);

/**
 * GET /api/webhooks/revenuecat/health
 * Health check endpoint for RevenueCat webhook configuration
 */
router.get('/revenuecat/health', webhookController.revenueCatHealthCheck);

module.exports = router;
