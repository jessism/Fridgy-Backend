/**
 * Webhook Controller
 * Handles Stripe webhook events
 */

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const webhookService = require('../services/webhookService');

/**
 * Handle Stripe webhook events
 * POST /api/webhooks/stripe
 *
 * IMPORTANT: This endpoint receives raw body (not JSON parsed)
 * for Stripe signature verification
 */
async function handleStripeWebhook(req, res) {
  const sig = req.headers['stripe-signature'];
  const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!endpointSecret) {
    console.error('[WebhookController] STRIPE_WEBHOOK_SECRET not configured');
    return res.status(500).send('Webhook secret not configured');
  }

  let event;

  try {
    // Verify webhook signature
    event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
  } catch (err) {
    console.error('[WebhookController] Signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  console.log('[WebhookController] Received event:', event.type, event.id);

  try {
    // Process the event (idempotent)
    const result = await webhookService.processWebhookEvent(event);

    // Always return 200 to Stripe (even if already processed)
    res.json({
      received: true,
      event_id: event.id,
      event_type: event.type,
      status: result.status
    });
  } catch (error) {
    console.error('[WebhookController] Error processing webhook:', error);

    // Still return 200 to prevent Stripe from retrying
    // (we've logged the error and can investigate/retry manually)
    res.status(200).json({
      received: true,
      event_id: event.id,
      error: error.message,
      status: 'error'
    });
  }
}

/**
 * Health check for webhook endpoint
 * GET /api/webhooks/stripe/health
 */
function healthCheck(req, res) {
  res.json({
    status: 'ok',
    webhook_secret_configured: !!process.env.STRIPE_WEBHOOK_SECRET,
    stripe_configured: !!process.env.STRIPE_SECRET_KEY,
    timestamp: new Date().toISOString()
  });
}

module.exports = {
  handleStripeWebhook,
  healthCheck,
};
