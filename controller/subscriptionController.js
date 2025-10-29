/**
 * Subscription Controller
 * Handles subscription-related API endpoints
 */

const stripeService = require('../services/stripeService');
const subscriptionService = require('../services/subscriptionService');
const usageService = require('../services/usageService');
const db = require('../config/database');

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

    res.json({
      success: true,
      subscription: subscription || {
        tier: 'free',
        status: null,
        is_grandfathered: false
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
    await db.query(`
      UPDATE subscriptions
      SET cancel_at_period_end = true, updated_at = NOW()
      WHERE stripe_subscription_id = $1
    `, [subscription.stripe_subscription_id]);

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
    await db.query(`
      UPDATE subscriptions
      SET cancel_at_period_end = false, updated_at = NOW()
      WHERE stripe_subscription_id = $1
    `, [subscription.stripe_subscription_id]);

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

    // Check if code exists and is active
    const result = await db.query(`
      SELECT * FROM promo_codes
      WHERE code = $1
      AND active = true
      AND (expires_at IS NULL OR expires_at > NOW())
      AND (max_redemptions IS NULL OR times_redeemed < max_redemptions)
    `, [code.toUpperCase()]);

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'INVALID_CODE',
        message: 'Promo code is invalid or expired'
      });
    }

    const promo = result.rows[0];

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
 */
async function applyPromoCode(req, res) {
  try {
    const userId = req.user.id || req.user.userId;
    const { code } = req.body;

    if (!code) {
      return res.status(400).json({
        success: false,
        error: 'CODE_REQUIRED',
        message: 'Promo code is required'
      });
    }

    // Get promo code
    const promoResult = await db.query(`
      SELECT * FROM promo_codes
      WHERE code = $1 AND active = true
    `, [code.toUpperCase()]);

    if (promoResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'INVALID_CODE',
        message: 'Promo code not found'
      });
    }

    const promo = promoResult.rows[0];

    // Check if user already redeemed this code
    const redemptionCheck = await db.query(`
      SELECT * FROM user_promo_codes
      WHERE user_id = $1 AND promo_code_id = $2
    `, [userId, promo.id]);

    if (redemptionCheck.rows.length > 0) {
      return res.status(400).json({
        success: false,
        error: 'ALREADY_REDEEMED',
        message: 'You have already redeemed this promo code'
      });
    }

    // Get user's subscription
    const subscription = await subscriptionService.getUserSubscription(userId);

    if (!subscription || !subscription.stripe_subscription_id) {
      return res.status(400).json({
        success: false,
        error: 'NO_SUBSCRIPTION',
        message: 'No active subscription found'
      });
    }

    // Apply to Stripe subscription
    await stripeService.applyPromoCode(subscription.stripe_subscription_id, promo.stripe_coupon_id);

    // Record redemption
    await db.query(`
      INSERT INTO user_promo_codes (user_id, promo_code_id, stripe_subscription_id)
      VALUES ($1, $2, $3)
    `, [userId, promo.id, subscription.stripe_subscription_id]);

    // Increment redemption count
    await db.query(`
      UPDATE promo_codes
      SET times_redeemed = times_redeemed + 1
      WHERE id = $1
    `, [promo.id]);

    res.json({
      success: true,
      message: 'Promo code applied successfully'
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
    const { promoCode } = req.body;

    // Check if user already has active subscription
    const existing = await subscriptionService.getUserSubscription(userId);
    if (existing && (existing.status === 'active' || existing.status === 'trialing')) {
      return res.status(400).json({
        success: false,
        error: 'ALREADY_SUBSCRIBED',
        message: 'You already have an active subscription'
      });
    }

    // Create subscription intent
    const intent = await stripeService.createSubscriptionIntent(userId, email, promoCode);

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
    console.log(`\n--- STEP 2: Update Users Table ---`);

    // NOW safe to activate - Update user tier
    const { getServiceClient } = require('../config/supabase');
    const supabase = getServiceClient();

    console.log('Updating user tier to premium...');
    const { error: userError } = await supabase
      .from('users')
      .update({ tier: 'premium' })
      .eq('id', userId);

    if (userError) {
      console.error('❌ Error updating user tier:', userError);
      throw userError;
    }
    console.log('✅ STEP 2 COMPLETE: User tier updated to premium');

    // IMMEDIATE ACTIVATION - Create/update subscription record
    console.log(`\n--- STEP 3: Upsert Subscription Record ---`);
    const trialStart = new Date();
    const trialEnd = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    const subscriptionData = {
      user_id: userId,
      stripe_subscription_id: subscriptionId,
      tier: 'premium',
      status: 'trialing',
      trial_start: trialStart.toISOString(),
      trial_end: trialEnd.toISOString(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };

    console.log('Upserting subscription with data:', subscriptionData);
    console.log('Using onConflict: user_id');

    const { error: subError } = await supabase
      .from('subscriptions')
      .upsert(subscriptionData, { onConflict: 'user_id' });

    if (subError) {
      console.error('❌ STEP 3 FAILED: Error upserting subscription:', subError);
      console.error('Error code:', subError.code);
      console.error('Error details:', subError.details);
      console.error('Error message:', subError.message);
      throw subError;
    }

    console.log(`✅ STEP 3 COMPLETE: Subscription record upserted`);

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
