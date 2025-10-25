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

module.exports = router;
