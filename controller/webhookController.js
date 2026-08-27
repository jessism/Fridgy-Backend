/**
 * Webhook Controller
 * Handles Stripe webhook events
 */

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const webhookService = require('../services/webhookService');
const tierSyncService = require('../services/tierSyncService');

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
// RevenueCat ids are emails for signed-in users and "$RCAnonymousID:..." before signup
function normalizeIds(ids) {
  const list = Array.isArray(ids) ? ids : [];
  return [...new Set(list.map(v => String(v || '').trim().toLowerCase()).filter(Boolean))];
}

function isEmailId(id) {
  return id.includes('@') && !id.startsWith('$rcanonymousid:');
}

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

  // TRANSFER has no app_user_id by design: RevenueCat moves a store subscription
  // between customers when the same Apple ID restores on another account, and the
  // payload carries transferred_from / transferred_to instead.
  const isTransfer = eventType === 'TRANSFER';
  const transferredFrom = isTransfer ? normalizeIds(event.event.transferred_from) : [];
  const transferredTo = isTransfer ? normalizeIds(event.event.transferred_to) : [];
  // Store the row under the destination, which is who RevenueCat sends it for
  const eventAppUserId = isTransfer ? (transferredTo.find(isEmailId) || null) : appUserId;

  if (!appUserId && !isTransfer) {
    console.error('[WebhookController] Missing app_user_id');
    return res.status(400).json({
      error: 'Invalid payload',
      message: 'app_user_id is required'
    });
  }

  // Purchases made on the onboarding upsell happen BEFORE the account exists, so
  // they arrive as app_user_id = "$RCAnonymousID:..." with no email in `aliases`.
  // There is no user to update here; users.tier is synced instead by the self-heal
  // in subscriptionController.getStatus on the user's first authenticated request.
  // Store the event for auditing and return 200 so RevenueCat stops retrying.
  if (!isTransfer && !appUserId.includes('@')) {
    console.warn('[WebhookController] Anonymous app_user_id — storing without processing:', rawAppUserId);
    try {
      const { getServiceClient } = require('../config/supabase');
      const supabase = getServiceClient();
      await supabase
        .from('revenuecat_webhook_events')
        .upsert({
          event_id: eventId,
          event_type: eventType,
          app_user_id: rawAppUserId,
          product_id: productId,
          payload: event,
          processed: false,
          error_message: 'anonymous_app_user_id',
          processing_attempts: 1
        }, { onConflict: 'event_id', ignoreDuplicates: true });
    } catch (logError) {
      console.error('[WebhookController] Failed to store anonymous event:', logError);
    }
    return res.json({
      received: true,
      event_id: eventId,
      event_type: eventType,
      status: 'anonymous_app_user_id'
    });
  }

  console.log('[WebhookController] RevenueCat event received:', {
    type: eventType,
    user: isTransfer ? `${transferredFrom.join(',')} -> ${transferredTo.join(',')}` : appUserId,
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
          app_user_id: eventAppUserId,
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
          upgradedUser.forEach(u => tierSyncService.invalidateTierCaches(u.id));
          console.log(`[WebhookController] ✅ User ${appUserId} upgraded to premium`);
          processingResult = { status: 'upgraded' };
        }
        break;

      case 'CANCELLATION':
      case 'BILLING_ISSUE': {
        // CANCELLATION = auto-renew turned off (or a refund); BILLING_ISSUE = Apple
        // grace period. Access continues until expiration_at_ms in both cases, and
        // RevenueCat sends EXPIRATION when it actually ends. Only downgrade now if
        // the expiry is already in the past (refunds move it to the refund time).
        const expirationMs = event.event.expiration_at_ms;
        if (!expirationMs || expirationMs > Date.now()) {
          console.log(`[WebhookController] ${eventType} for ${appUserId} — access continues until ${expirationMs ? new Date(expirationMs).toISOString() : 'unknown'}, keeping tier`);
          processingResult = { status: 'cancel_pending_expiry' };
          break;
        }
        console.log(`[WebhookController] ${eventType} for ${appUserId} with past expiry — treating as expiration`);
      }
      // falls through
      case 'EXPIRATION': {
        // User may lose premium access - the helper skips grandfathered / active-Stripe users
        console.log(`[WebhookController] Processing downgrade for ${appUserId} (${eventType})`);
        const result = await tierSyncService.downgradeUserIfEligible(appUserId, { reason: eventType });
        processingResult = result.status === 'error'
          ? { status: 'error', error: result.error }
          : { status: result.status };
        break;
      }

      case 'PRODUCT_CHANGE':
        // User switched products (e.g., monthly to annual) - keep premium
        console.log(`[WebhookController] Product change for ${appUserId} - maintaining premium`);
        processingResult = { status: 'product_change_ignored' };
        break;

      case 'TRANSFER': {
        // The source accounts lose the entitlement - RevenueCat revokes it on transfer
        // and sends all later events (RENEWAL, EXPIRATION) to the destination only.
        // The destination is NOT upgraded here: TRANSFER carries no expiry, so a
        // restore of an already-expired subscription would create a stale premium.
        // Their own RENEWAL and the self-heal in subscriptionController.getStatus
        // (which verifies with RevenueCat) cover the legitimate case.
        const toEmails = transferredTo.filter(isEmailId);
        const fromEmails = transferredFrom.filter(isEmailId).filter(e => !toEmails.includes(e));
        const fromAnonymous = transferredFrom.filter(id => !isEmailId(id));

        if (fromAnonymous.length) {
          console.warn('[WebhookController] TRANSFER: unresolvable source ids skipped:', fromAnonymous);
        }
        if (toEmails.length) {
          console.log(`[WebhookController] TRANSFER: destination ${toEmails.join(',')} not upgraded here; self-heal/RENEWAL will sync`);
        }

        const results = [];
        for (const email of fromEmails) {
          const r = await tierSyncService.downgradeUserIfEligible(email, { reason: 'TRANSFER' });
          console.log(`[WebhookController] TRANSFER source ${email}: ${r.status}`);
          results.push({ email, ...r });
        }

        const errors = results.filter(r => r.status === 'error');
        let status;
        if (!fromEmails.length) {
          status = 'transfer_no_resolvable_source';
        } else if (results.some(r => r.status === 'downgraded')) {
          status = 'transfer_downgraded';
        } else if (errors.length === results.length) {
          status = 'error';
        } else {
          status = 'transfer_skipped'; // all grandfathered / Stripe-active / not found / already free
        }
        processingResult = { status };
        if (errors.length) {
          processingResult.error = errors.map(e => `${e.email}: ${e.error}`).join('; ');
        }
        break;
      }

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
