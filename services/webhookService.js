/**
 * Webhook Service
 * Handles Stripe webhook events and syncs subscription state to database
 */

const { getServiceClient } = require('../config/supabase');
const subscriptionService = require('./subscriptionService');

/**
 * Process a Stripe webhook event (with idempotency)
 * @param {Object} event - Stripe event object
 * @returns {Promise<Object>} Processing result
 */
async function processWebhookEvent(event) {
  try {
    const supabase = getServiceClient();

    // Check if event already processed (idempotency)
    const { data: existing, error: checkError } = await supabase
      .from('stripe_webhook_events')
      .select('*')
      .eq('event_id', event.id)
      .single();

    if (checkError && checkError.code !== 'PGRST116') { // PGRST116 = no rows found
      console.error('[WebhookService] Error checking idempotency:', checkError);
      throw checkError;
    }

    if (existing && existing.processed) {
      console.log('[WebhookService] Event already processed:', event.id);
      return { status: 'already_processed', event_id: event.id };
    }

    // Log the webhook event
    await logWebhookEvent(event);

    // Route to appropriate handler
    const handlers = {
      'checkout.session.completed': handleCheckoutComplete,
      'customer.subscription.created': handleSubscriptionCreated,
      'customer.subscription.updated': handleSubscriptionUpdated,
      'customer.subscription.deleted': handleSubscriptionDeleted,
      'invoice.payment_succeeded': handlePaymentSucceeded,
      'invoice.payment_failed': handlePaymentFailed,
    };

    const handler = handlers[event.type];
    if (handler) {
      console.log('[WebhookService] Processing event:', event.type, event.id);
      await handler(event.data.object);
    } else {
      console.log('[WebhookService] No handler for event type:', event.type);
    }

    // Mark event as processed
    await markEventProcessed(event.id);

    return { status: 'processed', event_id: event.id };
  } catch (error) {
    console.error('[WebhookService] Error processing event:', error);

    // Log error
    try {
      const supabase = getServiceClient();

      // First get current processing_attempts
      const { data: currentEvent } = await supabase
        .from('stripe_webhook_events')
        .select('processing_attempts')
        .eq('event_id', event.id)
        .single();

      const newAttempts = (currentEvent?.processing_attempts || 0) + 1;

      const { error: updateError } = await supabase
        .from('stripe_webhook_events')
        .update({
          error_message: error.message,
          processing_attempts: newAttempts
        })
        .eq('event_id', event.id);

      if (updateError) {
        console.error('[WebhookService] Failed to log error:', updateError);
      }
    } catch (logError) {
      console.error('[WebhookService] Error logging webhook failure:', logError);
    }

    throw error;
  }
}

/**
 * Log webhook event to database
 * @param {Object} event - Stripe event
 */
async function logWebhookEvent(event) {
  try {
    const supabase = getServiceClient();

    const { error } = await supabase
      .from('stripe_webhook_events')
      .upsert({
        event_id: event.id,
        event_type: event.type,
        stripe_customer_id: event.data.object.customer || null,
        payload: event
      }, {
        onConflict: 'event_id',
        ignoreDuplicates: true
      });

    if (error) {
      console.error('[WebhookService] Error logging event:', error);
    }
  } catch (error) {
    console.error('[WebhookService] Error logging event:', error);
    // Don't throw - continue processing even if logging fails
  }
}

/**
 * Mark webhook event as processed
 * @param {string} eventId - Stripe event ID
 */
async function markEventProcessed(eventId) {
  try {
    const supabase = getServiceClient();

    const { error } = await supabase
      .from('stripe_webhook_events')
      .update({
        processed: true,
        processed_at: new Date().toISOString()
      })
      .eq('event_id', eventId);

    if (error) {
      console.error('[WebhookService] Error marking event processed:', error);
    }
  } catch (error) {
    console.error('[WebhookService] Error marking event processed:', error);
  }
}

/**
 * Handle checkout.session.completed event
 * Triggered when user completes payment in Stripe Checkout
 */
async function handleCheckoutComplete(session) {
  try {
    console.log('[WebhookService] Checkout completed:', session.id);

    const customerId = session.customer;
    const subscriptionId = session.subscription;
    const userId = session.client_reference_id || session.metadata.user_id;

    if (!userId) {
      console.error('[WebhookService] No user ID in checkout session');
      return;
    }

    // Get full subscription details from Stripe
    const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
    const subscription = await stripe.subscriptions.retrieve(subscriptionId);

    // Determine tier based on subscription status
    const tier = subscription.status === 'trialing' || subscription.status === 'active' ? 'premium' : 'free';

    // Create/update subscription in database
    await subscriptionService.upsertSubscription({
      userId,
      stripeCustomerId: customerId,
      stripeSubscriptionId: subscriptionId,
      stripePriceId: subscription.items.data[0].price.id,
      tier,
      status: subscription.status,
      trialStart: subscription.trial_start ? new Date(subscription.trial_start * 1000) : null,
      trialEnd: subscription.trial_end ? new Date(subscription.trial_end * 1000) : null,
      currentPeriodStart: new Date(subscription.current_period_start * 1000),
      currentPeriodEnd: new Date(subscription.current_period_end * 1000),
      cancelAtPeriodEnd: subscription.cancel_at_period_end,
      canceledAt: subscription.canceled_at ? new Date(subscription.canceled_at * 1000) : null,
    });

    console.log('[WebhookService] Subscription created for user:', userId, 'status:', subscription.status);
  } catch (error) {
    console.error('[WebhookService] Error handling checkout complete:', error);
    throw error;
  }
}

/**
 * Handle customer.subscription.created event
 */
async function handleSubscriptionCreated(subscription) {
  try {
    const supabase = getServiceClient();
    console.log('[WebhookService] Subscription created:', subscription.id);

    // Get user by customer ID
    const { data: existingSub, error: getError } = await supabase
      .from('subscriptions')
      .select('user_id')
      .eq('stripe_customer_id', subscription.customer)
      .single();

    if (getError && getError.code !== 'PGRST116') { // PGRST116 = no rows
      console.error('[WebhookService] Error getting subscription:', getError);
      throw getError;
    }

    if (!existingSub) {
      console.error('[WebhookService] No user found for customer:', subscription.customer);
      return;
    }

    const userId = existingSub.user_id;
    const tier = subscription.status === 'trialing' || subscription.status === 'active' ? 'premium' : 'free';

    await subscriptionService.upsertSubscription({
      userId,
      stripeCustomerId: subscription.customer,
      stripeSubscriptionId: subscription.id,
      stripePriceId: subscription.items.data[0].price.id,
      tier,
      status: subscription.status,
      trialStart: subscription.trial_start ? new Date(subscription.trial_start * 1000) : null,
      trialEnd: subscription.trial_end ? new Date(subscription.trial_end * 1000) : null,
      currentPeriodStart: new Date(subscription.current_period_start * 1000),
      currentPeriodEnd: new Date(subscription.current_period_end * 1000),
      cancelAtPeriodEnd: subscription.cancel_at_period_end,
      canceledAt: subscription.canceled_at ? new Date(subscription.canceled_at * 1000) : null,
    });
  } catch (error) {
    console.error('[WebhookService] Error handling subscription created:', error);
    throw error;
  }
}

/**
 * Handle customer.subscription.updated event
 * Triggered when subscription status changes (e.g., trial ends, cancellation scheduled)
 */
async function handleSubscriptionUpdated(subscription) {
  try {
    console.log('[WebhookService] Subscription updated:', subscription.id, 'status:', subscription.status);

    const dbSub = await subscriptionService.getSubscriptionByStripeId(subscription.id);
    if (!dbSub) {
      console.error('[WebhookService] Subscription not found in database:', subscription.id);
      return;
    }

    const tier = subscription.status === 'trialing' || subscription.status === 'active' ? 'premium' : 'free';

    await subscriptionService.upsertSubscription({
      userId: dbSub.user_id,
      stripeCustomerId: subscription.customer,
      stripeSubscriptionId: subscription.id,
      stripePriceId: subscription.items.data[0].price.id,
      tier,
      status: subscription.status,
      trialStart: subscription.trial_start ? new Date(subscription.trial_start * 1000) : null,
      trialEnd: subscription.trial_end ? new Date(subscription.trial_end * 1000) : null,
      currentPeriodStart: new Date(subscription.current_period_start * 1000),
      currentPeriodEnd: new Date(subscription.current_period_end * 1000),
      cancelAtPeriodEnd: subscription.cancel_at_period_end,
      canceledAt: subscription.canceled_at ? new Date(subscription.canceled_at * 1000) : null,
    });

    console.log('[WebhookService] Updated subscription for user:', dbSub.user_id);
  } catch (error) {
    console.error('[WebhookService] Error handling subscription updated:', error);
    throw error;
  }
}

/**
 * Handle customer.subscription.deleted event
 * Triggered when subscription ends (trial expired without payment, canceled, etc.)
 */
async function handleSubscriptionDeleted(subscription) {
  try {
    console.log('[WebhookService] Subscription deleted:', subscription.id);

    const dbSub = await subscriptionService.getSubscriptionByStripeId(subscription.id);
    if (!dbSub) {
      console.error('[WebhookService] Subscription not found in database:', subscription.id);
      return;
    }

    // Downgrade user to free tier
    await subscriptionService.downgradeToFree(dbSub.user_id);

    console.log('[WebhookService] User downgraded to free tier:', dbSub.user_id);
  } catch (error) {
    console.error('[WebhookService] Error handling subscription deleted:', error);
    throw error;
  }
}

/**
 * Handle invoice.payment_succeeded event
 * Triggered when payment succeeds (trial conversion, renewal, etc.)
 */
async function handlePaymentSucceeded(invoice) {
  try {
    console.log('[WebhookService] Payment succeeded for invoice:', invoice.id);

    const subscriptionId = invoice.subscription;
    if (!subscriptionId) return; // Not a subscription payment

    const dbSub = await subscriptionService.getSubscriptionByStripeId(subscriptionId);
    if (!dbSub) {
      console.error('[WebhookService] Subscription not found:', subscriptionId);
      return;
    }

    // Update status to active (in case it was past_due)
    await subscriptionService.updateSubscriptionStatus(subscriptionId, 'active');

    // Update user tier to premium
    const supabase = getServiceClient();
    const { error: userError } = await supabase
      .from('users')
      .update({ tier: 'premium' })
      .eq('id', dbSub.user_id);

    if (userError) {
      console.error('[WebhookService] Error updating user tier:', userError);
      throw userError;
    }

    console.log('[WebhookService] Payment succeeded, user active:', dbSub.user_id);
  } catch (error) {
    console.error('[WebhookService] Error handling payment succeeded:', error);
    throw error;
  }
}

/**
 * Handle invoice.payment_failed event
 * Triggered when payment fails (card declined, etc.)
 * Grace period logic: Keep access for 7 days before downgrading
 */
async function handlePaymentFailed(invoice) {
  try {
    console.log('[WebhookService] Payment failed for invoice:', invoice.id);

    const subscriptionId = invoice.subscription;
    if (!subscriptionId) return;

    const dbSub = await subscriptionService.getSubscriptionByStripeId(subscriptionId);
    if (!dbSub) {
      console.error('[WebhookService] Subscription not found:', subscriptionId);
      return;
    }

    // Update status to past_due (user keeps access during grace period)
    await subscriptionService.updateSubscriptionStatus(subscriptionId, 'past_due');

    // NOTE: Stripe will automatically send reminder emails and retry payments
    // After final retry fails (typically 7 days), subscription.deleted event will be sent
    // At that point, handleSubscriptionDeleted() will downgrade the user

    console.log('[WebhookService] Payment failed, user in grace period:', dbSub.user_id);
  } catch (error) {
    console.error('[WebhookService] Error handling payment failed:', error);
    throw error;
  }
}

module.exports = {
  processWebhookEvent,
  logWebhookEvent,
  markEventProcessed,
  handleCheckoutComplete,
  handleSubscriptionCreated,
  handleSubscriptionUpdated,
  handleSubscriptionDeleted,
  handlePaymentSucceeded,
  handlePaymentFailed,
};
