/**
 * Webhook Service
 * Handles Stripe webhook events and syncs subscription state to database
 */

const { getServiceClient } = require('../config/supabase');
const subscriptionService = require('./subscriptionService');
const emailService = require('./emailService');

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
      'promotion_code.created': handlePromotionCodeCreated,
      'promotion_code.updated': handlePromotionCodeUpdated,
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
  console.log('🔥 HANDLER CALLED: handleCheckoutComplete');
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

    // Determine tier based on subscription status AND payment method
    // Only grant premium if payment method is verified (prevents access before SetupIntent completes)
    const hasPaymentMethod = subscription.default_payment_method != null;
    const tier = (subscription.status === 'trialing' || subscription.status === 'active') && hasPaymentMethod
      ? 'premium'
      : 'free';

    console.log('[WebhookService] 🔍 handleCheckoutComplete - Subscription:', subscription.id);
    console.log('[WebhookService] 🔍 Subscription status:', subscription.status);
    console.log('[WebhookService] 🔍 default_payment_method:', subscription.default_payment_method);
    console.log('[WebhookService] 🔍 hasPaymentMethod:', hasPaymentMethod);
    console.log('[WebhookService] 🔍 Tier decision:', tier);

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
  console.log('🔥 HANDLER CALLED: handleSubscriptionCreated');
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

    // Only grant premium if payment method is verified (prevents access before SetupIntent completes)
    const hasPaymentMethod = subscription.default_payment_method != null;
    const tier = (subscription.status === 'trialing' || subscription.status === 'active') && hasPaymentMethod
      ? 'premium'
      : 'free';

    console.log('[WebhookService] 🔍 handleSubscriptionCreated - Subscription:', subscription.id);
    console.log('[WebhookService] 🔍 User ID:', userId);
    console.log('[WebhookService] 🔍 Subscription status:', subscription.status);
    console.log('[WebhookService] 🔍 default_payment_method:', subscription.default_payment_method);
    console.log('[WebhookService] 🔍 hasPaymentMethod:', hasPaymentMethod);
    console.log('[WebhookService] 🔍 Tier decision:', tier);

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

    // Send trial start email if user is starting a trial
    if (subscription.status === 'trialing' && subscription.trial_end) {
      console.log('[WebhookService] Trial started, sending email to user:', userId);

      // Get user details for email
      const { data: user, error: userError } = await supabase
        .from('users')
        .select('email, first_name')
        .eq('id', userId)
        .single();

      if (userError) {
        console.error('[WebhookService] Error fetching user for trial email:', userError);
      } else if (user) {
        // Get customer timezone from Stripe metadata
        let timezone = 'America/Los_Angeles'; // default
        try {
          const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
          const customer = await stripe.customers.retrieve(subscription.customer);
          if (customer.metadata && customer.metadata.timezone) {
            timezone = customer.metadata.timezone;
            console.log('[WebhookService] Retrieved customer timezone:', timezone);
          }
        } catch (tzError) {
          console.error('[WebhookService] Error fetching customer timezone:', tzError.message);
        }

        const trialEndDate = new Date(subscription.trial_end * 1000);
        await emailService.sendTrialStartEmail(user, trialEndDate, timezone);
      }
    }
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
  console.log('🔥 HANDLER CALLED: handleSubscriptionUpdated');
  try {
    console.log('[WebhookService] Subscription updated:', subscription.id, 'status:', subscription.status);

    const dbSub = await subscriptionService.getSubscriptionByStripeId(subscription.id);
    if (!dbSub) {
      console.error('[WebhookService] Subscription not found in database:', subscription.id);
      return;
    }

    // Only grant premium if payment method is verified (prevents access before SetupIntent completes)
    const hasPaymentMethod = subscription.default_payment_method != null;
    const tier = (subscription.status === 'trialing' || subscription.status === 'active') && hasPaymentMethod
      ? 'premium'
      : 'free';

    console.log('[WebhookService] 🔍 handleSubscriptionUpdated - Subscription:', subscription.id);
    console.log('[WebhookService] 🔍 User ID:', dbSub.user_id);
    console.log('[WebhookService] 🔍 Subscription status:', subscription.status);
    console.log('[WebhookService] 🔍 default_payment_method:', subscription.default_payment_method);
    console.log('[WebhookService] 🔍 hasPaymentMethod:', hasPaymentMethod);
    console.log('[WebhookService] 🔍 Tier decision:', tier);

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
  console.log('🔥 HANDLER CALLED: handlePaymentSucceeded');
  try {
    console.log('[WebhookService] Payment succeeded for invoice:', invoice.id);

    const subscriptionId = invoice.subscription;
    console.log('🔍 DEBUG: subscriptionId =', subscriptionId);
    if (!subscriptionId) {
      console.log('🔍 DEBUG: No subscription ID, returning early');
      return;
    }

    console.log('🔍 DEBUG: Looking up subscription in database:', subscriptionId);
    const dbSub = await subscriptionService.getSubscriptionByStripeId(subscriptionId);
    console.log('🔍 DEBUG: dbSub =', dbSub ? `found (user: ${dbSub.user_id})` : 'NULL - NOT FOUND');
    if (!dbSub) {
      console.error('[WebhookService] Subscription not found in database:', subscriptionId);
      return;
    }

    console.log('🔍 DEBUG: About to retrieve subscription from Stripe');
    // Get subscription from Stripe to check payment method
    const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
    const subscription = await stripe.subscriptions.retrieve(subscriptionId);
    console.log('🔍 DEBUG: Retrieved subscription from Stripe successfully');

    // Only grant premium if payment method is verified
    // This prevents granting access on $0 trial invoices before SetupIntent completes
    const hasPaymentMethod = subscription.default_payment_method != null;

    console.log('[WebhookService] 🔍 handlePaymentSucceeded - Invoice:', invoice.id);
    console.log('[WebhookService] 🔍 User ID:', dbSub.user_id);
    console.log('[WebhookService] 🔍 Amount paid:', invoice.amount_paid);
    console.log('[WebhookService] 🔍 Billing reason:', invoice.billing_reason);
    console.log('[WebhookService] 🔍 Subscription:', subscription.id);
    console.log('[WebhookService] 🔍 Subscription status:', subscription.status);
    console.log('[WebhookService] 🔍 default_payment_method:', subscription.default_payment_method);
    console.log('[WebhookService] 🔍 hasPaymentMethod:', hasPaymentMethod);

    // Update status to active (in case it was past_due)
    await subscriptionService.updateSubscriptionStatus(subscriptionId, 'active');

    // Only update user tier to premium if payment method is verified
    if (hasPaymentMethod) {
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
    } else {
      console.log('[WebhookService] Skipping tier update - no payment method yet for:', dbSub.user_id);
    }

    // Send payment success email (especially important for trial conversions)
    if (invoice.billing_reason === 'subscription_cycle' || invoice.billing_reason === 'subscription_create') {
      console.log('[WebhookService] Sending payment success email to user:', dbSub.user_id);

      // Get user details for email
      const { data: user, error: userFetchError } = await supabase
        .from('users')
        .select('email, first_name')
        .eq('id', dbSub.user_id)
        .single();

      if (userFetchError) {
        console.error('[WebhookService] Error fetching user for payment email:', userFetchError);
      } else if (user) {
        // Get subscription to find next billing date
        const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
        const subscription = await stripe.subscriptions.retrieve(subscriptionId);
        const nextBillingDate = new Date(subscription.current_period_end * 1000);

        await emailService.sendPaymentSuccessEmail(
          user,
          invoice.amount_paid,
          nextBillingDate
        );
      }
    }
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

/**
 * Handle promotion_code.created event
 * Triggered when a promotion code is created in Stripe Dashboard
 * Automatically syncs the promo code to the database
 */
async function handlePromotionCodeCreated(promotionCode) {
  try {
    console.log('\n========================================');
    console.log('[WebhookService] 🎯 PROMOTION CODE CREATED WEBHOOK RECEIVED');
    console.log('[WebhookService] Promotion code:', promotionCode.code);
    console.log('[WebhookService] Full promotion code object:', JSON.stringify(promotionCode, null, 2));

    // Fetch the associated coupon details from Stripe
    const couponId = promotionCode.promotion?.coupon || promotionCode.coupon;
    console.log('[WebhookService] 📡 Fetching coupon from Stripe:', couponId);
    const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
    const coupon = await stripe.coupons.retrieve(couponId);

    console.log('[WebhookService] ✅ Retrieved coupon details:', coupon.id);
    console.log('[WebhookService] Coupon data:', JSON.stringify(coupon, null, 2));

    // Prepare promo code data for database
    const promoData = {
      id: require('uuid').v4(),
      code: promotionCode.code.toUpperCase(),
      stripe_coupon_id: coupon.id,
      discount_type: coupon.percent_off ? 'percent' : 'fixed',
      discount_value: coupon.percent_off || (coupon.amount_off / 100), // Convert cents to dollars for fixed
      duration: coupon.duration, // 'once', 'repeating', 'forever'
      duration_in_months: coupon.duration_in_months || null,
      max_redemptions: promotionCode.max_redemptions || null,
      times_redeemed: 0,
      active: promotionCode.active,
      expires_at: promotionCode.expires_at ? new Date(promotionCode.expires_at * 1000) : null,
      created_at: new Date(),
      updated_at: new Date()
    };

    console.log('[WebhookService] 💾 Attempting database insert with data:', JSON.stringify(promoData, null, 2));

    // Insert into database (upsert in case it already exists)
    const { getServiceClient } = require('../config/supabase');
    const supabase = getServiceClient();

    const { data, error } = await supabase
      .from('promo_codes')
      .upsert(promoData, {
        onConflict: 'code',
        ignoreDuplicates: false
      })
      .select();

    if (error) {
      console.error('[WebhookService] ❌ ERROR inserting promo code:', error);
      console.error('[WebhookService] Error details:', JSON.stringify(error, null, 2));
      throw error;
    }

    console.log('[WebhookService] ✅ SUCCESS! Database insert result:', JSON.stringify(data, null, 2));
    console.log('[WebhookService] ✅ Promo code synced to database:', promotionCode.code);
    console.log('========================================\n');

  } catch (error) {
    console.error('[WebhookService] ❌ FATAL ERROR handling promotion code created:', error);
    console.error('[WebhookService] Error stack:', error.stack);
    throw error;
  }
}

/**
 * Handle promotion_code.updated event
 * Triggered when a promotion code is updated in Stripe Dashboard
 * Updates the existing promo code in the database
 */
async function handlePromotionCodeUpdated(promotionCode) {
  try {
    console.log('[WebhookService] Promotion code updated:', promotionCode.code);

    // Prepare update data
    const updateData = {
      active: promotionCode.active,
      max_redemptions: promotionCode.max_redemptions || null,
      times_redeemed: promotionCode.times_redeemed || 0,
      expires_at: promotionCode.expires_at ? new Date(promotionCode.expires_at * 1000) : null,
      updated_at: new Date()
    };

    // Update in database
    const { getServiceClient } = require('../config/supabase');
    const supabase = getServiceClient();

    const { data, error } = await supabase
      .from('promo_codes')
      .update(updateData)
      .eq('code', promotionCode.code.toUpperCase())
      .select();

    if (error) {
      console.error('[WebhookService] Error updating promo code:', error);
      throw error;
    }

    if (!data || data.length === 0) {
      console.warn('[WebhookService] ⚠️  Promo code not found in database, creating it');
      // If not found, treat as creation
      await handlePromotionCodeCreated(promotionCode);
    } else {
      console.log('[WebhookService] ✅ Promo code updated in database:', promotionCode.code);
    }

  } catch (error) {
    console.error('[WebhookService] Error handling promotion code updated:', error);
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
  handlePromotionCodeCreated,
  handlePromotionCodeUpdated,
};
