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

/**
 * Handle RevenueCat webhook events
 * POST /api/webhooks/revenuecat
 *
 * Updates users.tier based on subscription events from App Store purchases
 * Includes idempotency, Stripe conflict detection, and comprehensive error handling
 */
async function handleRevenueCatWebhook(req, res) {
  // ============================================
  // STEP 1: VERIFY WEBHOOK SIGNATURE
  // ============================================
  const authHeader = req.headers['authorization'];
  const webhookSecret = process.env.REVENUECAT_WEBHOOK_SECRET;

  if (webhookSecret) {
    if (!authHeader || authHeader !== `Bearer ${webhookSecret}`) {
      console.error('[WebhookController] Invalid RevenueCat webhook authorization');
      return res.status(401).json({ error: 'Unauthorized' });
    }
  } else {
    console.warn('[WebhookController] ⚠️  REVENUECAT_WEBHOOK_SECRET not set - webhook is unauthenticated!');
  }

  // ============================================
  // STEP 2: VALIDATE PAYLOAD STRUCTURE
  // ============================================
  const event = req.body;

  if (!event || !event.event || !event.event.type) {
    console.error('[WebhookController] Invalid RevenueCat webhook payload');
    return res.status(400).json({
      error: 'Invalid payload',
      message: 'Missing event.event.type'
    });
  }

  const eventType = event.event.type;
  const eventId = event.event.id;
  const productId = event.event.product_id;

  // Normalize email (mobile sends lowercase, match exactly)
  const rawAppUserId = event.event.app_user_id || '';
  const appUserId = rawAppUserId.toLowerCase().trim();

  // Validate email format
  if (!appUserId || !appUserId.includes('@')) {
    console.error('[WebhookController] Invalid app_user_id:', rawAppUserId);
    return res.status(400).json({
      error: 'Invalid payload',
      message: 'app_user_id must be a valid email'
    });
  }

  console.log('[WebhookController] RevenueCat event received:', {
    type: eventType,
    user: appUserId,
    product: productId,
    id: eventId
  });

  try {
    const { getServiceClient } = require('../config/supabase');
    const supabase = getServiceClient();

    // ============================================
    // STEP 3: LOG EVENT (IDEMPOTENCY CHECK)
    // ============================================
    const { data: existingEvent, error: checkError } = await supabase
      .from('revenuecat_webhook_events')
      .select('*')
      .eq('event_id', eventId)
      .single();

    if (checkError && checkError.code !== 'PGRST116') { // PGRST116 = no rows found
      console.error('[WebhookController] Error checking event idempotency:', checkError);
      throw checkError;
    }

    if (existingEvent && existingEvent.processed) {
      console.log('[WebhookController] Event already processed:', eventId);
      return res.json({
        received: true,
        event_id: eventId,
        event_type: eventType,
        status: 'already_processed'
      });
    }

    // Log the event (insert or update)
    if (!existingEvent) {
      await supabase
        .from('revenuecat_webhook_events')
        .insert({
          event_id: eventId,
          event_type: eventType,
          app_user_id: appUserId,
          product_id: productId,
          payload: event,
          processed: false,
          processing_attempts: 1
        });
    } else {
      await supabase
        .from('revenuecat_webhook_events')
        .update({
          processing_attempts: existingEvent.processing_attempts + 1
        })
        .eq('event_id', eventId);
    }

    // ============================================
    // STEP 4: PROCESS EVENT BY TYPE
    // ============================================
    let processingResult = { status: 'ignored' };

    switch (eventType) {
      case 'INITIAL_PURCHASE':
      case 'RENEWAL':
      case 'UNCANCELLATION':
      case 'NON_RENEWING_PURCHASE':
        // User gained premium access
        console.log(`[WebhookController] Upgrading user ${appUserId} to premium`);

        const { data: upgradedUser, error: upgradeError } = await supabase
          .from('users')
          .update({ tier: 'premium' })
          .eq('email', appUserId)
          .select('id, email, tier');

        if (upgradeError) {
          console.error('[WebhookController] Error updating user tier:', upgradeError);
          processingResult = { status: 'error', error: upgradeError.message };
        } else if (!upgradedUser || upgradedUser.length === 0) {
          console.warn(`[WebhookController] User not found: ${appUserId}`);
          processingResult = { status: 'user_not_found' };
        } else {
          console.log(`[WebhookController] ✅ User ${appUserId} upgraded to premium`);
          processingResult = { status: 'upgraded' };
        }
        break;

      case 'CANCELLATION':
      case 'EXPIRATION':
      case 'BILLING_ISSUE':
        // User may lose premium access - check conflicts first
        console.log(`[WebhookController] Processing downgrade for ${appUserId}`);

        // Get user data
        const { data: userData, error: userError } = await supabase
          .from('users')
          .select('id, is_grandfathered')
          .eq('email', appUserId)
          .single();

        if (userError || !userData) {
          console.warn(`[WebhookController] User not found for downgrade: ${appUserId}`);
          processingResult = { status: 'user_not_found' };
          break;
        }

        // CRITICAL: Check if user is grandfathered
        if (userData.is_grandfathered) {
          console.log(`[WebhookController] User ${appUserId} is grandfathered - keeping premium`);
          processingResult = { status: 'grandfathered_skip' };
          break;
        }

        // CRITICAL: Check if user has active Stripe subscription
        const { data: stripeSub, error: stripeError } = await supabase
          .from('subscriptions')
          .select('status')
          .eq('user_id', userData.id)
          .single();

        if (!stripeError && stripeSub && (stripeSub.status === 'active' || stripeSub.status === 'trialing')) {
          console.log(`[WebhookController] User ${appUserId} has active Stripe subscription - keeping premium`);
          processingResult = { status: 'stripe_active_skip' };
          break;
        }

        // Safe to downgrade - no conflicts
        const { data: downgradedUser, error: downgradeError } = await supabase
          .from('users')
          .update({ tier: 'free' })
          .eq('email', appUserId)
          .select('id, email, tier');

        if (downgradeError) {
          console.error('[WebhookController] Error downgrading user:', downgradeError);
          processingResult = { status: 'error', error: downgradeError.message };
        } else if (!downgradedUser || downgradedUser.length === 0) {
          console.warn(`[WebhookController] User not found for downgrade: ${appUserId}`);
          processingResult = { status: 'user_not_found' };
        } else {
          console.log(`[WebhookController] ✅ User ${appUserId} downgraded to free`);
          processingResult = { status: 'downgraded' };
        }
        break;

      case 'PRODUCT_CHANGE':
        // User switched products (e.g., monthly to annual) - keep premium
        console.log(`[WebhookController] Product change for ${appUserId} - maintaining premium`);
        processingResult = { status: 'product_change_ignored' };
        break;

      case 'TRANSFER':
        // Subscription transferred between users - handle if needed in future
        console.log(`[WebhookController] Transfer event for ${appUserId}`);
        processingResult = { status: 'transfer_ignored' };
        break;

      default:
        console.log(`[WebhookController] Unhandled event type: ${eventType}`);
        processingResult = { status: 'unhandled_event_type' };
    }

    // ============================================
    // STEP 5: MARK EVENT AS PROCESSED
    // ============================================
    await supabase
      .from('revenuecat_webhook_events')
      .update({
        processed: true,
        processed_at: new Date().toISOString(),
        error_message: processingResult.error || null
      })
      .eq('event_id', eventId);

    // ============================================
    // STEP 6: RETURN SUCCESS RESPONSE
    // ============================================
    // Always return 200 OK to RevenueCat (prevent retries)
    res.json({
      received: true,
      event_id: eventId,
      event_type: eventType,
      status: processingResult.status
    });

  } catch (error) {
    console.error('[WebhookController] Error processing RevenueCat webhook:', error);

    // Log error to database
    try {
      const { getServiceClient } = require('../config/supabase');
      const supabase = getServiceClient();
      await supabase
        .from('revenuecat_webhook_events')
        .update({
          error_message: error.message
        })
        .eq('event_id', eventId);
    } catch (logError) {
      console.error('[WebhookController] Error logging webhook error:', logError);
    }

    // Still return 200 to prevent RevenueCat from retrying
    res.status(200).json({
      received: true,
      event_id: eventId,
      error: error.message,
      status: 'error'
    });
  }
}

/**
 * Health check for RevenueCat webhook endpoint
 * GET /api/webhooks/revenuecat/health
 */
function revenueCatHealthCheck(req, res) {
  res.json({
    status: 'ok',
    revenuecat_secret_configured: !!process.env.REVENUECAT_SECRET_API_KEY,
    revenuecat_webhook_secret_configured: !!process.env.REVENUECAT_WEBHOOK_SECRET,
    endpoint: '/api/webhooks/revenuecat',
    timestamp: new Date().toISOString()
  });
}

module.exports = {
  handleStripeWebhook,
  healthCheck,
  handleRevenueCatWebhook,
  revenueCatHealthCheck,
};
