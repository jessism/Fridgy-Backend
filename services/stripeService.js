/**
 * Stripe Service
 * Handles all Stripe API operations for subscription management
 */

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

/**
 * Get or create a Stripe customer for a user
 * @param {Object} user - User object with id, email, firstName, timezone
 * @returns {Promise<string>} Stripe customer ID
 */
async function getOrCreateCustomer(user) {
  try {
    const { getServiceClient } = require('../config/supabase');
    const supabase = getServiceClient();

    // Check if user already has a Stripe customer ID
    const { data: subscription, error: fetchError } = await supabase
      .from('subscriptions')
      .select('stripe_customer_id')
      .eq('user_id', user.id)
      .single();

    // If found and has customer ID, update timezone if provided and return it
    if (!fetchError && subscription && subscription.stripe_customer_id) {
      console.log('[StripeService] Found existing customer:', subscription.stripe_customer_id);

      // Update customer metadata with timezone if provided
      if (user.timezone) {
        await stripe.customers.update(subscription.stripe_customer_id, {
          metadata: {
            user_id: user.id,
            timezone: user.timezone,
            app: 'fridgy'
          }
        });
        console.log('[StripeService] Updated customer timezone:', user.timezone);
      }

      return subscription.stripe_customer_id;
    }

    // Create new Stripe customer with timezone
    const customer = await stripe.customers.create({
      email: user.email,
      name: user.firstName || user.first_name,
      metadata: {
        user_id: user.id,
        timezone: user.timezone || 'America/Los_Angeles',
        app: 'fridgy'
      }
    });

    console.log('[StripeService] Created customer:', customer.id, 'for user:', user.id, 'timezone:', user.timezone);

    // Store customer ID in subscriptions table
    const { error: upsertError } = await supabase
      .from('subscriptions')
      .upsert({
        user_id: user.id,
        stripe_customer_id: customer.id,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      }, { onConflict: 'user_id' });

    if (upsertError) {
      console.error('[StripeService] Error storing customer ID:', upsertError);
      // Don't throw - customer was created in Stripe, we can continue
    }

    return customer.id;
  } catch (error) {
    console.error('[StripeService] Error in getOrCreateCustomer:', error);
    throw error;
  }
}

/**
 * Create a Stripe Subscription Intent for Payment Element
 * Uses payment_behavior: 'default_incomplete' for frontend confirmation
 * @param {string} userId - User ID
 * @param {string} email - User email
 * @param {string|null} promoCode - Optional promo code
 * @param {string|null} timezone - User's timezone (IANA format)
 * @returns {Promise<Object>} { subscriptionId, clientSecret }
 */
async function createSubscriptionIntent(userId, email, promoCode = null, timezone = null) {
  try {
    const priceId = process.env.STRIPE_PRICE_ID;

    if (!priceId) {
      throw new Error('STRIPE_PRICE_ID not configured in environment variables');
    }

    // Get or create Stripe customer with timezone
    const customerId = await getOrCreateCustomer({ id: userId, email, timezone });

    const subscriptionData = {
      customer: customerId,
      items: [{ price: priceId }],
      payment_behavior: 'default_incomplete', // Payment pending until frontend confirms
      payment_settings: {
        save_default_payment_method: 'on_subscription' // Save card for renewals
      },
      expand: ['latest_invoice.payment_intent'], // Get PaymentIntent for clientSecret
      trial_period_days: 7, // 7-day free trial
      metadata: {
        user_id: userId,
        promo_code: promoCode || null
      }
    };

    // If promo code provided, validate and apply using modern Stripe API
    if (promoCode) {
      console.log('[StripeService] Looking up promotion code in Stripe:', promoCode);

      // Look up the promotion code ID from Stripe (modern approach)
      const promoCodes = await stripe.promotionCodes.list({
        code: promoCode,
        active: true,
        limit: 1
      });

      if (promoCodes.data.length > 0) {
        const promoCodeId = promoCodes.data[0].id;
        subscriptionData.discounts = [{ promotion_code: promoCodeId }];
        console.log('[StripeService] Applied promo code:', promoCode, '-> ID:', promoCodeId);
      } else {
        console.warn('[StripeService] Promotion code not found in Stripe:', promoCode);
      }
    }

    // Create subscription (will be in 'incomplete' status until payment confirms)
    const subscription = await stripe.subscriptions.create(subscriptionData);

    console.log('[StripeService] Created subscription intent:', subscription.id, 'for user:', userId);
    console.log('[StripeService] Subscription status:', subscription.status);

    // For TRIAL subscriptions, Stripe creates a SetupIntent (not PaymentIntent)
    // This is because there's no charge during trial - just card verification
    if (subscription.pending_setup_intent) {
      console.log('[StripeService] Trial subscription - using SetupIntent:', subscription.pending_setup_intent);

      // Retrieve the SetupIntent to get its client_secret
      const setupIntent = await stripe.setupIntents.retrieve(subscription.pending_setup_intent);

      console.log('[StripeService] ✅ SetupIntent retrieved, client_secret ready');

      return {
        subscriptionId: subscription.id,
        clientSecret: setupIntent.client_secret,
        requiresSetup: true, // Flag to indicate this is a SetupIntent
        isTrial: true
      };
    }

    // For NON-TRIAL subscriptions (immediate charge), use PaymentIntent
    if (subscription.latest_invoice?.payment_intent?.client_secret) {
      console.log('[StripeService] Non-trial subscription - using PaymentIntent');

      return {
        subscriptionId: subscription.id,
        clientSecret: subscription.latest_invoice.payment_intent.client_secret,
        requiresSetup: false,
        isTrial: false
      };
    }

    // If we get here, something unexpected happened
    throw new Error('No SetupIntent or PaymentIntent found in subscription');

  } catch (error) {
    console.error('[StripeService] Error creating subscription intent:', error);
    throw error;
  }
}

/**
 * Create a Stripe Checkout Session (LEGACY - for backwards compatibility)
 * @param {string} userId - User ID
 * @param {string} email - User email
 * @param {string} priceId - Stripe price ID
 * @param {string|null} promoCode - Optional promo code
 * @param {string|null} returnUrl - Return URL for cancellation
 * @returns {Promise<Object>} Checkout session
 */
async function createCheckoutSession(userId, email, priceId = null, promoCode = null, returnUrl = null) {
  try {
    const actualPriceId = priceId || process.env.STRIPE_PRICE_ID;

    if (!actualPriceId) {
      throw new Error('STRIPE_PRICE_ID not configured in environment variables');
    }

    // Get or create Stripe customer
    const customerId = await getOrCreateCustomer({ id: userId, email });

    const sessionConfig = {
      ui_mode: 'embedded',
      mode: 'subscription',
      payment_method_types: ['card'],
      line_items: [{
        price: actualPriceId,
        quantity: 1,
      }],
      return_url: `${process.env.FRONTEND_URL}/subscription-success?session_id={CHECKOUT_SESSION_ID}&fallback=true`,
      customer: customerId,
      client_reference_id: userId,
      metadata: { user_id: userId },
      subscription_data: {
        trial_period_days: 7,
        metadata: { user_id: userId },
      },
      allow_promotion_codes: true
    };

    // Apply promo code if provided
    if (promoCode) {
      const { getServiceClient } = require('../config/supabase');
      const supabase = getServiceClient();

      const { data: promo, error: promoError } = await supabase
        .from('promo_codes')
        .select('stripe_coupon_id')
        .eq('code', promoCode)
        .eq('active', true)
        .single();

      if (!promoError && promo && promo.stripe_coupon_id) {
        sessionConfig.discounts = [{
          coupon: promo.stripe_coupon_id,
        }];
        console.log('[StripeService] Applied promo code:', promoCode);
      }
    }

    const session = await stripe.checkout.sessions.create(sessionConfig);

    console.log('[StripeService] Created checkout session (legacy):', session.id);

    return {
      sessionId: session.id,
      clientSecret: session.client_secret,
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
 * @param {string} promoCode - Promo code string (will be looked up in Stripe)
 * @returns {Promise<Object>} Updated subscription
 */
async function applyPromoCode(subscriptionId, promoCode) {
  try {
    // Look up the promotion code ID from Stripe
    const promoCodes = await stripe.promotionCodes.list({
      code: promoCode,
      active: true,
      limit: 1
    });

    if (promoCodes.data.length === 0) {
      throw new Error('Promotion code not found or inactive in Stripe');
    }

    const promoCodeId = promoCodes.data[0].id;

    const subscription = await stripe.subscriptions.update(subscriptionId, {
      discounts: [{ promotion_code: promoCodeId }],
      metadata: {
        promo_code: promoCode
      }
    });

    console.log('[StripeService] Applied promo code to subscription:', subscriptionId, '-> Code:', promoCode);

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
  createCheckoutSession, // Keep for backwards compatibility
  createSubscriptionIntent, // NEW: For Payment Element
  createPortalSession,
  cancelSubscription,
  reactivateSubscription,
  applyPromoCode,
  getSubscription,
  getCustomer,
  createPromoCoupon,
};
