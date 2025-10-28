/**
 * Stripe Service
 * Handles all Stripe API operations for subscription management
 */

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

/**
 * Get or create a Stripe customer for a user
 * @param {Object} user - User object with id, email, firstName
 * @param {Object} db - Database connection
 * @returns {Promise<string>} Stripe customer ID
 */
async function getOrCreateCustomer(user, db) {
  try {
    // Check if user already has a Stripe customer ID
    const result = await db.query(
      'SELECT stripe_customer_id FROM subscriptions WHERE user_id = $1',
      [user.id]
    );

    if (result.rows.length > 0 && result.rows[0].stripe_customer_id) {
      return result.rows[0].stripe_customer_id;
    }

    // Create new Stripe customer
    const customer = await stripe.customers.create({
      email: user.email,
      name: user.firstName || user.first_name,
      metadata: {
        user_id: user.id,
        app: 'fridgy'
      }
    });

    console.log('[StripeService] Created customer:', customer.id, 'for user:', user.id);

    // Store customer ID
    await db.query(`
      INSERT INTO subscriptions (user_id, stripe_customer_id)
      VALUES ($1, $2)
      ON CONFLICT (user_id) DO UPDATE SET stripe_customer_id = $2
    `, [user.id, customer.id]);

    return customer.id;
  } catch (error) {
    console.error('[StripeService] Error creating customer:', error);
    throw error;
  }
}

/**
 * Create a Stripe Checkout Session for subscription signup
 * @param {string} userId - User ID
 * @param {string} email - User email
 * @param {string} priceId - Stripe price ID
 * @param {string|null} promoCode - Optional promo code
 * @returns {Promise<Object>} Checkout session with URL
 */
async function createCheckoutSession(userId, email, priceId = null, promoCode = null, returnUrl = null) {
  try {
    const actualPriceId = priceId || process.env.STRIPE_PRICE_ID;

    if (!actualPriceId) {
      throw new Error('STRIPE_PRICE_ID not configured in environment variables');
    }

    // Use provided returnUrl or default to home
    const cancelPath = returnUrl || '/home';
    const cancelUrl = `${process.env.FRONTEND_URL}${cancelPath}`;

    const sessionConfig = {
      ui_mode: 'embedded', // Embedded checkout for in-app payments
      mode: 'subscription',
      payment_method_types: ['card'],
      line_items: [
        {
          price: actualPriceId,
          quantity: 1,
        },
      ],
      // IMPORTANT: return_url is now only a fallback for edge cases
      // Normal flow will NOT trigger this because onComplete handles it in CheckoutModal
      // But we keep it in case JavaScript fails or user refreshes during checkout
      return_url: `${process.env.FRONTEND_URL}/subscription-success?session_id={CHECKOUT_SESSION_ID}&fallback=true`,
      customer_email: email,
      client_reference_id: userId,
      metadata: {
        user_id: userId,
      },
      subscription_data: {
        trial_period_days: 7,
        metadata: {
          user_id: userId,
        },
      },
      allow_promotion_codes: true // Allow users to enter promo codes
    };

    // If promo code provided, add it
    if (promoCode) {
      // Validate promo code exists in our database
      const db = require('../config/database');
      const promoResult = await db.query(
        'SELECT stripe_coupon_id FROM promo_codes WHERE code = $1 AND active = true',
        [promoCode]
      );

      if (promoResult.rows.length > 0 && promoResult.rows[0].stripe_coupon_id) {
        sessionConfig.discounts = [{
          coupon: promoResult.rows[0].stripe_coupon_id,
        }];
      }
    }

    const session = await stripe.checkout.sessions.create(sessionConfig);

    console.log('[StripeService] Created checkout session:', session.id, 'for user:', userId);

    return {
      sessionId: session.id,
      clientSecret: session.client_secret, // For embedded checkout
    };
  } catch (error) {
    console.error('[StripeService] Error creating checkout session:', error);
    throw error;
  }
}

/**
 * Create a Stripe Customer Portal session for billing management
 * @param {string} customerId - Stripe customer ID
 * @returns {Promise<Object>} Portal session with URL
 */
async function createPortalSession(customerId) {
  try {
    const session = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: `${process.env.FRONTEND_URL}/billing`,
    });

    console.log('[StripeService] Created portal session for customer:', customerId);

    return {
      url: session.url,
    };
  } catch (error) {
    console.error('[StripeService] Error creating portal session:', error);
    throw error;
  }
}

/**
 * Cancel a subscription (at period end)
 * @param {string} subscriptionId - Stripe subscription ID
 * @returns {Promise<Object>} Updated subscription
 */
async function cancelSubscription(subscriptionId) {
  try {
    const subscription = await stripe.subscriptions.update(subscriptionId, {
      cancel_at_period_end: true,
    });

    console.log('[StripeService] Scheduled cancellation for subscription:', subscriptionId);

    return subscription;
  } catch (error) {
    console.error('[StripeService] Error canceling subscription:', error);
    throw error;
  }
}

/**
 * Reactivate a canceled subscription (undo cancel_at_period_end)
 * @param {string} subscriptionId - Stripe subscription ID
 * @returns {Promise<Object>} Updated subscription
 */
async function reactivateSubscription(subscriptionId) {
  try {
    const subscription = await stripe.subscriptions.update(subscriptionId, {
      cancel_at_period_end: false,
    });

    console.log('[StripeService] Reactivated subscription:', subscriptionId);

    return subscription;
  } catch (error) {
    console.error('[StripeService] Error reactivating subscription:', error);
    throw error;
  }
}

/**
 * Apply a promo code to an existing subscription
 * @param {string} subscriptionId - Stripe subscription ID
 * @param {string} couponId - Stripe coupon ID
 * @returns {Promise<Object>} Updated subscription
 */
async function applyPromoCode(subscriptionId, couponId) {
  try {
    const subscription = await stripe.subscriptions.update(subscriptionId, {
      coupon: couponId,
    });

    console.log('[StripeService] Applied promo code to subscription:', subscriptionId);

    return subscription;
  } catch (error) {
    console.error('[StripeService] Error applying promo code:', error);
    throw error;
  }
}

/**
 * Retrieve subscription details from Stripe
 * @param {string} subscriptionId - Stripe subscription ID
 * @returns {Promise<Object>} Subscription object
 */
async function getSubscription(subscriptionId) {
  try {
    const subscription = await stripe.subscriptions.retrieve(subscriptionId);
    return subscription;
  } catch (error) {
    console.error('[StripeService] Error retrieving subscription:', error);
    throw error;
  }
}

/**
 * Retrieve customer details from Stripe
 * @param {string} customerId - Stripe customer ID
 * @returns {Promise<Object>} Customer object
 */
async function getCustomer(customerId) {
  try {
    const customer = await stripe.customers.retrieve(customerId);
    return customer;
  } catch (error) {
    console.error('[StripeService] Error retrieving customer:', error);
    throw error;
  }
}

/**
 * Create a promo code in Stripe
 * @param {Object} promoData - Promo code data
 * @returns {Promise<Object>} Created coupon
 */
async function createPromoCoupon(promoData) {
  try {
    const coupon = await stripe.coupons.create({
      duration: promoData.duration, // 'once', 'repeating', 'forever'
      duration_in_months: promoData.duration === 'repeating' ? promoData.durationInMonths : undefined,
      percent_off: promoData.discountType === 'percent' ? promoData.discountValue : undefined,
      amount_off: promoData.discountType === 'fixed' ? Math.round(promoData.discountValue * 100) : undefined,
      currency: promoData.discountType === 'fixed' ? 'usd' : undefined,
      max_redemptions: promoData.maxRedemptions,
      name: promoData.code,
    });

    console.log('[StripeService] Created promo coupon:', coupon.id);

    return coupon;
  } catch (error) {
    console.error('[StripeService] Error creating promo coupon:', error);
    throw error;
  }
}

module.exports = {
  getOrCreateCustomer,
  createCheckoutSession,
  createPortalSession,
  cancelSubscription,
  reactivateSubscription,
  applyPromoCode,
  getSubscription,
  getCustomer,
  createPromoCoupon,
};
