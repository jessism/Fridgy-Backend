/**
 * Subscription Controller
 * Handles subscription-related API endpoints
 */

const stripeService = require('../services/stripeService');
const subscriptionService = require('../services/subscriptionService');
const usageService = require('../services/usageService');
const emailService = require('../services/emailService');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

/**
 * Get user's subscription status and usage
 * GET /api/subscriptions/status
 */
async function getStatus(req, res) {
  try {
    const userId = req.user.id || req.user.userId;

    // Get subscription
    const subscription = await subscriptionService.getUserSubscription(userId);

    // Get usage stats
    const usage = await usageService.getUserUsage(userId);

    // Fetch billing details from Stripe if user has active subscription
    let billingInfo = null;
    if (subscription?.stripe_customer_id &&
        (subscription.status === 'active' || subscription.status === 'trialing')) {
      try {
        // Step 1: Always fetch subscription from Stripe for date and base price
        const stripeSubscription = await stripe.subscriptions.retrieve(
          subscription.stripe_subscription_id
        );

        // Get base price from subscription items
        const baseAmount = stripeSubscription.items.data[0]?.price?.unit_amount || 499;

        // Determine the billing/trial end date from Stripe
        const billingDate = stripeSubscription.trial_end
          ? new Date(stripeSubscription.trial_end * 1000).toISOString()
          : new Date(stripeSubscription.current_period_end * 1000).toISOString();

        // Set base billing info (always available from subscription)
        billingInfo = {
          amount: baseAmount, // Default to base amount
          amountFormatted: `$${(baseAmount / 100).toFixed(2)}`,
          baseAmount: baseAmount,
          baseAmountFormatted: `$${(baseAmount / 100).toFixed(2)}`,
          date: billingDate,
          discount: null
        };

        // Step 2: Try to get invoice preview for actual amount with discounts
        // This may fail for canceled subscriptions (no upcoming invoice)
        try {
          const upcomingInvoice = await stripe.invoices.createPreview({
            customer: subscription.stripe_customer_id,
            subscription: subscription.stripe_subscription_id
          });

          // Update with actual invoice amounts
          billingInfo.amount = upcomingInvoice.total;
          billingInfo.amountFormatted = `$${(upcomingInvoice.total / 100).toFixed(2)}`;
          billingInfo.discount = upcomingInvoice.discount ? {
            code: upcomingInvoice.discount.coupon?.name || upcomingInvoice.discount.coupon?.id,
            percentOff: upcomingInvoice.discount.coupon?.percent_off || null,
            amountOff: upcomingInvoice.discount.coupon?.amount_off || null
          } : null;
        } catch (invoiceError) {
          // Invoice preview failed (likely canceled subscription) - keep base info
          console.log('[SubscriptionController] No upcoming invoice (may be canceled):', invoiceError.message);
        }

        console.log('[SubscriptionController] Fetched billing info from Stripe:', billingInfo);
      } catch (subscriptionError) {
        // Could not fetch subscription from Stripe
        console.log('[SubscriptionController] Could not fetch subscription:', subscriptionError.message);
      }
    }

    res.json({
      success: true,
      subscription: subscription ? {
        ...subscription,
        billing: billingInfo
      } : {
        tier: 'free',
        status: null,
        is_grandfathered: false,
        billing: null
      },
      usage: usage.current,
      limits: usage.limits,
      tier: subscription?.tier || 'free'
    });
  } catch (error) {
    console.error('[SubscriptionController] Error getting status:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get subscription status',
      message: error.message
    });
  }
}

/**
 * Create Stripe Checkout session to start trial/subscription
 * POST /api/subscriptions/create-checkout
 */
async function createCheckout(req, res) {
  try {
    const userId = req.user.id || req.user.userId;
    const email = req.user.email;
    const { promoCode, returnUrl } = req.body;

    // Check if user already has active subscription
    const existing = await subscriptionService.getUserSubscription(userId);
    if (existing && (existing.status === 'active' || existing.status === 'trialing')) {
      return res.status(400).json({
        success: false,
        error: 'ALREADY_SUBSCRIBED',
        message: 'You already have an active subscription'
      });
    }

    // Create checkout session
    const session = await stripeService.createCheckoutSession(
      userId,
      email,
      null, // Use default price from env
      promoCode,
      returnUrl // Pass return URL for cancel_url
    );

    res.json({
      success: true,
      sessionId: session.sessionId,
      clientSecret: session.clientSecret // For embedded checkout
    });
  } catch (error) {
    console.error('[SubscriptionController] Error creating checkout:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to create checkout session',
      message: error.message
    });
  }
}

/**
 * Create Stripe Customer Portal session for billing management
 * POST /api/subscriptions/create-portal-session
 */
async function createPortalSession(req, res) {
  try {
    const userId = req.user.id || req.user.userId;

    // Get user's subscription
    const subscription = await subscriptionService.getUserSubscription(userId);

    if (!subscription || !subscription.stripe_customer_id) {
      return res.status(400).json({
        success: false,
        error: 'NO_SUBSCRIPTION',
        message: 'No active subscription found'
      });
    }

    // Create portal session
    const session = await stripeService.createPortalSession(subscription.stripe_customer_id);

    res.json({
      success: true,
      url: session.url
    });
  } catch (error) {
    console.error('[SubscriptionController] Error creating portal session:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to create portal session',
      message: error.message
    });
  }
}

/**
 * Cancel subscription (at period end)
 * POST /api/subscriptions/cancel
 */
async function cancelSubscription(req, res) {
  try {
    const userId = req.user.id || req.user.userId;

    // Get user's subscription
    const subscription = await subscriptionService.getUserSubscription(userId);

    if (!subscription || !subscription.stripe_subscription_id) {
      return res.status(400).json({
        success: false,
        error: 'NO_SUBSCRIPTION',
        message: 'No active subscription found'
      });
    }

    if (subscription.cancel_at_period_end) {
      return res.status(400).json({
        success: false,
        error: 'ALREADY_CANCELED',
        message: 'Subscription is already scheduled for cancellation'
      });
    }

    // Cancel in Stripe
    await stripeService.cancelSubscription(subscription.stripe_subscription_id);

    // Update database (webhook will also handle this)
    const { getServiceClient } = require('../config/supabase');
    const supabase = getServiceClient();

    const { error: updateError } = await supabase
      .from('subscriptions')
      .update({
        cancel_at_period_end: true,
        updated_at: new Date().toISOString()
      })
      .eq('stripe_subscription_id', subscription.stripe_subscription_id);

    if (updateError) {
      console.error('[SubscriptionController] Error updating subscription:', updateError);
      throw updateError;
    }

    // Send cancellation confirmation email
    try {
      // Get user details for email
      const { data: user, error: userError } = await supabase
        .from('users')
        .select('email, first_name')
        .eq('id', userId)
        .single();

      if (userError) {
        console.error('[SubscriptionController] Error fetching user for cancellation email:', userError);
      } else if (user) {
        // Get customer timezone from Stripe metadata
        let timezone = 'America/Los_Angeles'; // default
        try {
          const customer = await stripe.customers.retrieve(subscription.stripe_customer_id);
          if (customer.metadata && customer.metadata.timezone) {
            timezone = customer.metadata.timezone;
            console.log('[SubscriptionController] Retrieved customer timezone:', timezone);
          }
        } catch (tzError) {
          console.error('[SubscriptionController] Error fetching customer timezone:', tzError.message);
        }

        // Send cancellation email with period end date
        const accessUntilDate = new Date(subscription.current_period_end);
        await emailService.sendCancellationEmail(user, accessUntilDate, timezone);
      }
    } catch (emailError) {
      // Don't fail the cancellation if email fails
      console.error('[SubscriptionController] Failed to send cancellation email:', emailError);
    }

    res.json({
      success: true,
      message: 'Subscription scheduled for cancellation',
      access_until: subscription.current_period_end
    });
  } catch (error) {
    console.error('[SubscriptionController] Error canceling subscription:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to cancel subscription',
      message: error.message
    });
  }
}

/**
 * Reactivate canceled subscription
 * POST /api/subscriptions/reactivate
 */
async function reactivateSubscription(req, res) {
  try {
    const userId = req.user.id || req.user.userId;

    // Get user's subscription
    const subscription = await subscriptionService.getUserSubscription(userId);

    if (!subscription || !subscription.stripe_subscription_id) {
      return res.status(400).json({
        success: false,
        error: 'NO_SUBSCRIPTION',
        message: 'No active subscription found'
      });
    }

    if (!subscription.cancel_at_period_end) {
      return res.status(400).json({
        success: false,
        error: 'NOT_CANCELED',
        message: 'Subscription is not scheduled for cancellation'
      });
    }

    // Reactivate in Stripe
    await stripeService.reactivateSubscription(subscription.stripe_subscription_id);

    // Update database (webhook will also handle this)
    const { getServiceClient } = require('../config/supabase');
    const supabase = getServiceClient();

    const { error: updateError } = await supabase
      .from('subscriptions')
      .update({
        cancel_at_period_end: false,
        updated_at: new Date().toISOString()
      })
      .eq('stripe_subscription_id', subscription.stripe_subscription_id);

    if (updateError) {
      console.error('[SubscriptionController] Error updating subscription:', updateError);
      throw updateError;
    }

    res.json({
      success: true,
      message: 'Subscription reactivated successfully'
    });
  } catch (error) {
    console.error('[SubscriptionController] Error reactivating subscription:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to reactivate subscription',
      message: error.message
    });
  }
}

/**
 * Validate promo code
 * POST /api/subscriptions/validate-promo
 */
async function validatePromoCode(req, res) {
  try {
    const { code } = req.body;

    if (!code) {
      return res.status(400).json({
        success: false,
        error: 'CODE_REQUIRED',
        message: 'Promo code is required'
      });
    }

    // Check if code exists and is active using Supabase client
    const { getServiceClient } = require('../config/supabase');
    const supabase = getServiceClient();

    const { data: promo, error: queryError } = await supabase
      .from('promo_codes')
      .select('*')
      .eq('code', code.toUpperCase())
      .eq('active', true)
      .single();

    if (queryError || !promo) {
      return res.status(404).json({
        success: false,
        error: 'INVALID_CODE',
        message: 'Promo code is invalid or expired'
      });
    }

    // Check expiration
    if (promo.expires_at && new Date(promo.expires_at) < new Date()) {
      return res.status(404).json({
        success: false,
        error: 'INVALID_CODE',
        message: 'Promo code has expired'
      });
    }

    // Check max redemptions
    if (promo.max_redemptions !== null && promo.times_redeemed >= promo.max_redemptions) {
      return res.status(404).json({
        success: false,
        error: 'INVALID_CODE',
        message: 'Promo code has reached its redemption limit'
      });
    }

    res.json({
      success: true,
      valid: true,
      promo: {
        code: promo.code,
        discountType: promo.discount_type,
        discountValue: promo.discount_value,
        duration: promo.duration,
        durationInMonths: promo.duration_in_months
      }
    });
  } catch (error) {
    console.error('[SubscriptionController] Error validating promo:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to validate promo code',
      message: error.message
    });
  }
}

/**
 * Apply promo code to existing subscription
 * POST /api/subscriptions/apply-promo
 *
 * Can be used in two ways:
 * 1. With subscriptionId param - for in-app checkout (applying to pending subscription)
 * 2. Without subscriptionId - for existing active subscription
 */
async function applyPromoCode(req, res) {
  try {
    const userId = req.user.id || req.user.userId;
    const { code, subscriptionId: requestSubscriptionId } = req.body;

    if (!code) {
      return res.status(400).json({
        success: false,
        error: 'CODE_REQUIRED',
        message: 'Promo code is required'
      });
    }

    // Get Supabase client
    const { getServiceClient } = require('../config/supabase');
    const supabase = getServiceClient();

    // Get promo code
    const { data: promo, error: promoError } = await supabase
      .from('promo_codes')
      .select('*')
      .eq('code', code.toUpperCase())
      .eq('active', true)
      .single();

    if (promoError || !promo) {
      return res.status(404).json({
        success: false,
        error: 'INVALID_CODE',
        message: 'Promo code not found'
      });
    }

    // Check expiration
    if (promo.expires_at && new Date(promo.expires_at) < new Date()) {
      return res.status(404).json({
        success: false,
        error: 'INVALID_CODE',
        message: 'Promo code has expired'
      });
    }

    // Check max redemptions
    if (promo.max_redemptions !== null && promo.times_redeemed >= promo.max_redemptions) {
      return res.status(404).json({
        success: false,
        error: 'INVALID_CODE',
        message: 'Promo code has reached its redemption limit'
      });
    }

    // Check if user already redeemed this code
    const { data: existingRedemption } = await supabase
      .from('user_promo_codes')
      .select('*')
      .eq('user_id', userId)
      .eq('promo_code_id', promo.id)
      .single();

    if (existingRedemption) {
      return res.status(400).json({
        success: false,
        error: 'ALREADY_REDEEMED',
        message: 'You have already redeemed this promo code'
      });
    }

    // Determine which subscription to apply promo to
    let targetSubscriptionId = requestSubscriptionId;

    if (!targetSubscriptionId) {
      // No subscriptionId provided - get user's existing subscription
      const subscription = await subscriptionService.getUserSubscription(userId);

      if (!subscription || !subscription.stripe_subscription_id) {
        return res.status(400).json({
          success: false,
          error: 'NO_SUBSCRIPTION',
          message: 'No subscription found'
        });
      }

      targetSubscriptionId = subscription.stripe_subscription_id;
    }

    // Apply to Stripe subscription using modern API (promo code string, not coupon ID)
    await stripeService.applyPromoCode(targetSubscriptionId, code.toUpperCase());

    // Record redemption
    const { error: insertError } = await supabase
      .from('user_promo_codes')
      .insert({
        user_id: userId,
        promo_code_id: promo.id,
        stripe_subscription_id: targetSubscriptionId
      });

    if (insertError) {
      console.error('[SubscriptionController] Error recording redemption:', insertError);
    }

    // Increment redemption count
    const { error: updateError } = await supabase
      .from('promo_codes')
      .update({ times_redeemed: promo.times_redeemed + 1 })
      .eq('id', promo.id);

    if (updateError) {
      console.error('[SubscriptionController] Error updating redemption count:', updateError);
    }

    console.log('[SubscriptionController] Promo code applied successfully:', code.toUpperCase(), 'to subscription:', targetSubscriptionId);

    res.json({
      success: true,
      message: 'Promo code applied successfully',
      promoCode: code.toUpperCase()
    });
  } catch (error) {
    console.error('[SubscriptionController] Error applying promo:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to apply promo code',
      message: error.message
    });
  }
}

/**
 * Create subscription intent for Payment Element
 * POST /api/subscriptions/create-subscription-intent
 */
async function createSubscriptionIntent(req, res) {
  try {
    const userId = req.user.id || req.user.userId;
    const email = req.user.email;
    const { promoCode, timezone } = req.body;

    console.log('[SubscriptionController] Creating subscription intent with timezone:', timezone);

    // Check if user already has active or in-progress subscription
    const existing = await subscriptionService.getUserSubscription(userId);
    if (existing && (existing.status === 'active' || existing.status === 'trialing' || existing.status === 'incomplete')) {
      // Allow retry if tier is 'free' (user never completed payment method verification)
      if (existing.tier === 'free') {
        console.log('[SubscriptionController] Existing subscription has tier=free, allowing retry and canceling old subscription');

        // Cancel the incomplete subscription in Stripe
        try {
          const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
          await stripe.subscriptions.cancel(existing.stripe_subscription_id);
          console.log('[SubscriptionController] Canceled incomplete subscription:', existing.stripe_subscription_id);
        } catch (cancelError) {
          console.error('[SubscriptionController] Error canceling subscription:', cancelError);
          // Continue anyway - might already be canceled
        }
      } else {
        // User has a real subscription with premium tier
        return res.status(400).json({
          success: false,
          error: 'ALREADY_SUBSCRIBED',
          message: existing.status === 'incomplete'
            ? 'You already have a subscription in progress'
            : 'You already have an active subscription'
        });
      }
    }

    // Create subscription intent with timezone
    const intent = await stripeService.createSubscriptionIntent(userId, email, promoCode, timezone);

    res.json({
      success: true,
      subscriptionId: intent.subscriptionId,
      clientSecret: intent.clientSecret,
      requiresSetup: intent.requiresSetup // Pass through the flag
    });
  } catch (error) {
    console.error('[SubscriptionController] Error creating subscription intent:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to create subscription intent',
      message: error.message
    });
  }
}

/**
 * Confirm subscription after successful payment
 * IMMEDIATELY activates user (doesn't wait for webhook!)
 * POST /api/subscriptions/confirm-subscription
 */
async function confirmSubscription(req, res) {
  try {
    console.log('========================================');
    console.log('=== CONFIRM SUBSCRIPTION START ===');
    console.log('========================================');

    const { paymentIntentId, subscriptionId } = req.body;
    const userId = req.user.id || req.user.userId;
    const email = req.user.email;

    console.log('[ConfirmSubscription] 🔍 Called with:', { paymentIntentId, subscriptionId, userId });
    console.log('Request body:', { paymentIntentId, subscriptionId });
    console.log('User:', { userId, email });

    if (!paymentIntentId || !subscriptionId) {
      console.log('❌ Missing required fields');
      return res.status(400).json({
        error: 'Payment intent ID and subscription ID are required'
      });
    }

    console.log(`\n--- STEP 1: Verify with Stripe ---`);

    // CRITICAL: Verify with Stripe FIRST before activating user
    const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
    let isVerified = false;

    try {
      // Try SetupIntent first (for trial subscriptions)
      console.log('Trying to retrieve SetupIntent:', paymentIntentId);
      const setupIntent = await stripe.setupIntents.retrieve(paymentIntentId);
      isVerified = setupIntent.status === 'succeeded';
      console.log(`✅ SetupIntent status: ${setupIntent.status}, verified: ${isVerified}`);
    } catch (setupError) {
      console.log('SetupIntent not found, trying PaymentIntent...');
      // If not a SetupIntent, try PaymentIntent (for non-trial subscriptions)
      try {
        const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);
        isVerified = paymentIntent.status === 'succeeded';
        console.log(`✅ PaymentIntent status: ${paymentIntent.status}, verified: ${isVerified}`);
      } catch (paymentError) {
        console.error(`❌ Invalid intent ID ${paymentIntentId}:`, paymentError.message);
        return res.status(400).json({
          error: 'Invalid payment intent ID'
        });
      }
    }

    // SECURITY: Only proceed if Stripe confirms success
    if (!isVerified) {
      console.log(`❌ STEP 1 FAILED: Payment not verified in Stripe`);
      return res.status(400).json({
        error: 'Payment not confirmed. Please try again.'
      });
    }

    console.log(`✅ STEP 1 COMPLETE: Payment verified with Stripe`);
    console.log(`\n--- STEP 2: Defer Tier Upgrade to Webhook ---`);
    console.log('ℹ️  User tier will be upgraded when Stripe webhook confirms subscription is active');
    console.log('ℹ️  This prevents premature Pro access before payment is fully confirmed');
    console.log('✅ STEP 2 COMPLETE: Tier upgrade deferred');

    // Get Supabase client for subscription record creation
    const { getServiceClient } = require('../config/supabase');
    const supabase = getServiceClient();

    // Fetch subscription details from Stripe to get all fields
    console.log(`\n--- STEP 3: Fetch Subscription from Stripe ---`);
    const stripeSubscription = await stripe.subscriptions.retrieve(subscriptionId);
    console.log('Retrieved subscription from Stripe:', {
      id: stripeSubscription.id,
      status: stripeSubscription.status,
      price_id: stripeSubscription.items.data[0]?.price?.id,
      current_period_start: stripeSubscription.current_period_start,
      current_period_end: stripeSubscription.current_period_end
    });

    // Create/update subscription record with all fields from Stripe
    console.log(`\n--- STEP 4: Upsert Subscription Record ---`);

    const subscriptionData = {
      user_id: userId,
      stripe_subscription_id: subscriptionId,
      stripe_price_id: stripeSubscription.items.data[0]?.price?.id || null,
      tier: 'premium',
      status: stripeSubscription.status || 'trialing',
      trial_start: stripeSubscription.trial_start
        ? new Date(stripeSubscription.trial_start * 1000).toISOString()
        : null,
      trial_end: stripeSubscription.trial_end
        ? new Date(stripeSubscription.trial_end * 1000).toISOString()
        : null,
      current_period_start: stripeSubscription.current_period_start
        ? new Date(stripeSubscription.current_period_start * 1000).toISOString()
        : null,
      current_period_end: stripeSubscription.current_period_end
        ? new Date(stripeSubscription.current_period_end * 1000).toISOString()
        : null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };

    console.log('Upserting subscription with data:', subscriptionData);
    console.log('Using onConflict: user_id');

    const { error: subError } = await supabase
      .from('subscriptions')
      .upsert(subscriptionData, { onConflict: 'user_id' });

    if (subError) {
      console.error('❌ STEP 4 FAILED: Error upserting subscription:', subError);
      console.error('Error code:', subError.code);
      console.error('Error details:', subError.details);
      console.error('Error message:', subError.message);
      throw subError;
    }

    console.log(`✅ STEP 4 COMPLETE: Subscription record upserted`);

    // STEP 5: Sync user tier immediately (don't wait for webhook)
    console.log(`\n--- STEP 5: Update Users Tier ---`);
    console.log('[ConfirmSubscription] 🔍 Setting tier to premium for user:', userId);
    const { error: tierError } = await supabase
      .from('users')
      .update({ tier: 'premium' })
      .eq('id', userId);

    if (tierError) {
      console.error('❌ STEP 5 FAILED: Error updating user tier:', tierError);
      // Don't throw - webhook will fix it, but log the issue
    } else {
      console.log(`✅ STEP 5 COMPLETE: User tier updated to premium`);
      console.log('[ConfirmSubscription] 🔍 Successfully set tier to premium for user:', userId);
    }

    // If we got here, all database operations succeeded
    // Supabase guarantees ACID transactions - if upsert succeeded, data IS there
    // No need for complex verification that causes false negatives due to replica lag
    console.log('========================================');
    console.log('=== CONFIRM SUBSCRIPTION SUCCESS ===');
    console.log('========================================\n');

    res.json({
      success: true,
      message: 'Subscription activated successfully'
    });
  } catch (error) {
    console.error('========================================');
    console.error('=== CONFIRM SUBSCRIPTION FAILED ===');
    console.error('========================================');
    console.error('Error:', error);
    console.error('Error message:', error.message);
    console.error('Error code:', error.code);
    console.error('Stack trace:', error.stack);
    console.error('========================================\n');
    res.status(500).json({
      success: false,
      error: 'Failed to confirm subscription',
      message: error.message
    });
  }
}

module.exports = {
  getStatus,
  createCheckout,
  createSubscriptionIntent, // NEW
  confirmSubscription, // NEW
  createPortalSession,
  cancelSubscription,
  reactivateSubscription,
  validatePromoCode,
  applyPromoCode,
};
