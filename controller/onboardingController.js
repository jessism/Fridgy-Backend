const { createClient } = require('@supabase/supabase-js');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

// Helper function to get Supabase client
const getSupabaseClient = () => {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_KEY; // Use service role for backend operations

  if (!supabaseUrl || !supabaseKey) {
    throw new Error('Supabase configuration missing');
  }

  return createClient(supabaseUrl, supabaseKey);
};

// JWT secret
const JWT_SECRET = process.env.JWT_SECRET || 'your-super-secret-jwt-key-change-in-production';

// Helper function to get user ID from token
const getUserIdFromToken = (req) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  
  if (!token) {
    throw new Error('No token provided');
  }
  
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    return decoded.userId;
  } catch (error) {
    throw new Error('Invalid token');
  }
};

// Onboarding Controller Functions
const onboardingController = {
  
  /**
   * Save onboarding progress
   * POST /api/onboarding/save-progress
   */
  async saveProgress(req, res) {
    try {
      console.log('🔄 Saving onboarding progress...');
      
      // For unauthenticated users, just return success
      // Progress is saved in localStorage on the frontend
      const { step, data } = req.body;
      
      // Optionally save to session storage or temporary table
      // For now, we'll just acknowledge receipt
      
      res.json({
        success: true,
        message: 'Progress saved',
        step,
        timestamp: new Date().toISOString()
      });
      
    } catch (error) {
      console.error('❌ Error saving progress:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to save progress'
      });
    }
  },
  
  /**
   * Get onboarding progress
   * GET /api/onboarding/progress
   */
  async getProgress(req, res) {
    try {
      // For unauthenticated users, return empty progress
      // Real progress is in localStorage
      
      res.json({
        success: true,
        progress: null,
        message: 'No server-side progress found'
      });
      
    } catch (error) {
      console.error('❌ Error fetching progress:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to fetch progress'
      });
    }
  },
  
  /**
   * Complete onboarding with user data
   * POST /api/onboarding/complete
   */
  async completeOnboarding(req, res) {
    try {
      console.log('🎯 Completing onboarding...');
      
      // Get user ID from JWT token
      const userId = getUserIdFromToken(req);
      console.log('User ID:', userId);
      
      const {
        primary_goal,
        household_size,
        weekly_budget,
        budget_currency,
        notification_preferences,
        onboarding_completed,
        onboarding_version
      } = req.body;
      
      const supabase = getSupabaseClient();
      
      // Check if onboarding data already exists
      const { data: existingData, error: checkError } = await supabase
        .from('user_onboarding_data')
        .select('id')
        .eq('user_id', userId)
        .single();
      
      let result;
      
      if (existingData && !checkError) {
        // Update existing onboarding data
        const { data: updatedData, error: updateError } = await supabase
          .from('user_onboarding_data')
          .update({
            primary_goal,
            household_size,
            weekly_budget,
            budget_currency,
            notification_preferences,
            onboarding_completed,
            onboarding_version,
            updated_at: new Date().toISOString()
          })
          .eq('user_id', userId)
          .select()
          .single();
        
        if (updateError) {
          throw updateError;
        }
        
        result = updatedData;
      } else {
        // Insert new onboarding data
        const { data: newData, error: insertError } = await supabase
          .from('user_onboarding_data')
          .insert({
            user_id: userId,
            primary_goal,
            household_size,
            weekly_budget,
            budget_currency,
            notification_preferences,
            onboarding_completed,
            onboarding_version
          })
          .select()
          .single();
        
        if (insertError) {
          throw insertError;
        }
        
        result = newData;
      }
      
      console.log('✅ Onboarding completed successfully');
      
      res.json({
        success: true,
        message: 'Onboarding completed successfully',
        data: result
      });
      
    } catch (error) {
      console.error('❌ Error completing onboarding:', error);
      
      const statusCode = error.message?.includes('token') ? 401 : 500;
      
      res.status(statusCode).json({
        success: false,
        error: error.message?.includes('token') 
          ? 'Authentication required' 
          : 'Failed to complete onboarding'
      });
    }
  },
  
  /**
   * Get user onboarding data
   * GET /api/user-onboarding
   */
  async getUserOnboardingData(req, res) {
    try {
      console.log('🔄 Fetching user onboarding data...');

      // Get user ID from JWT token
      const userId = getUserIdFromToken(req);
      console.log('User ID:', userId);

      const supabase = getSupabaseClient();

      // Fetch onboarding data for the user
      const { data: onboardingData, error } = await supabase
        .from('user_onboarding_data')
        .select('*')
        .eq('user_id', userId)
        .single();

      if (error && error.code !== 'PGRST116') {
        // PGRST116 is "not found" which is expected for users without onboarding data
        throw error;
      }

      console.log('✅ Onboarding data fetched successfully');

      res.json({
        success: true,
        hasOnboardingData: !!onboardingData,
        onboardingData: onboardingData || null,
        message: onboardingData ? 'Onboarding data found' : 'No onboarding data found'
      });

    } catch (error) {
      console.error('❌ Error fetching onboarding data:', error);

      const statusCode = error.message?.includes('token') ? 401 : 500;

      res.status(statusCode).json({
        success: false,
        error: error.message?.includes('token')
          ? 'Authentication required'
          : 'Failed to fetch onboarding data'
      });
    }
  },

  /**
   * Skip onboarding
   * POST /api/onboarding/skip
   */
  async skipOnboarding(req, res) {
    try {
      console.log('⏭️ Skipping onboarding...');

      // Get user ID from JWT token (if available)
      let userId = null;
      try {
        userId = getUserIdFromToken(req);
      } catch (error) {
        // User not authenticated yet, that's okay for skip
        console.log('Skipping without authentication');
      }

      if (userId) {
        const supabase = getSupabaseClient();

        // Save minimal onboarding data
        await supabase
          .from('user_onboarding_data')
          .insert({
            user_id: userId,
            onboarding_completed: false,
            onboarding_version: '1.0',
            primary_goal: 'skipped'
          });
      }

      res.json({
        success: true,
        message: 'Onboarding skipped'
      });

    } catch (error) {
      console.error('❌ Error skipping onboarding:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to skip onboarding'
      });
    }
  },

  /**
   * Create onboarding session for anonymous users
   * POST /api/onboarding/create-session
   */
  async createOnboardingSession(req, res) {
    try {
      console.log('🔐 Creating onboarding session...');

      const sessionId = uuidv4();
      const expiresAt = new Date();
      expiresAt.setHours(expiresAt.getHours() + 24); // Session expires in 24 hours

      const supabase = getSupabaseClient();

      // Create onboarding session
      const { data: session, error } = await supabase
        .from('onboarding_sessions')
        .insert({
          session_id: sessionId,
          created_at: new Date().toISOString(),
          expires_at: expiresAt.toISOString(),
          metadata: {}
        })
        .select()
        .single();

      if (error) {
        console.error('❌ Database error creating session:', error);
        throw error;
      }

      console.log('✅ Onboarding session created:', sessionId);

      res.json({
        success: true,
        sessionId: sessionId,
        expiresAt: expiresAt.toISOString()
      });

    } catch (error) {
      console.error('❌ Error creating onboarding session:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to create onboarding session'
      });
    }
  },

  /**
   * Create payment intent for anonymous onboarding user
   * POST /api/onboarding/create-payment-intent
   */
  async createPaymentIntent(req, res) {
    try {
      console.log('💳 Creating payment intent for onboarding...');

      const { sessionId, priceId = process.env.STRIPE_PRICE_ID, isOnboarding = true, promoCode = null } = req.body;

      if (!sessionId) {
        return res.status(400).json({
          success: false,
          error: 'Session ID required'
        });
      }

      if (!priceId) {
        return res.status(400).json({
          success: false,
          error: 'Price ID not configured'
        });
      }

      const supabase = getSupabaseClient();

      // Verify session exists and is valid
      const { data: session, error: sessionError } = await supabase
        .from('onboarding_sessions')
        .select('*')
        .eq('session_id', sessionId)
        .single();

      // Diagnostic logging
      console.log('[Onboarding] Session lookup:', {
        sessionId,
        found: !!session,
        error: sessionError?.message || sessionError?.code || null
      });

      if (sessionError || !session) {
        console.error('[Onboarding] ❌ Session validation failed:', {
          sessionId,
          errorCode: sessionError?.code,
          errorMessage: sessionError?.message,
          errorDetails: sessionError?.details
        });
        return res.status(400).json({
          success: false,
          error: 'Invalid or expired session'
        });
      }

      // Check if session is expired
      if (new Date(session.expires_at) < new Date()) {
        return res.status(400).json({
          success: false,
          error: 'Session has expired'
        });
      }

      // Check if session already has a payment
      if (session.stripe_subscription_id && session.payment_confirmed) {
        return res.status(400).json({
          success: false,
          error: 'Session already has a completed payment'
        });
      }

      // If session already has a subscription (not confirmed), update it instead of creating new
      if (session.stripe_subscription_id && !session.payment_confirmed) {
        console.log('[Onboarding] Session already has subscription:', session.stripe_subscription_id);

        // If promo code is being applied, update the existing subscription
        if (promoCode) {
          console.log('[Onboarding] Updating existing subscription with promo code:', promoCode);

          // Look up the promotion code ID from Stripe
          const promoCodes = await stripe.promotionCodes.list({
            code: promoCode,
            active: true,
            limit: 1
          });

          if (promoCodes.data.length === 0) {
            console.error('[Onboarding] Promotion code not found in Stripe:', promoCode);
            throw new Error('Promotion code not found or inactive in Stripe');
          }

          const promoCodeId = promoCodes.data[0].id;
          console.log('[Onboarding] Applying promo code to existing subscription:', promoCode, '→ ID:', promoCodeId);

          // Update existing subscription with the promo discount
          await stripe.subscriptions.update(session.stripe_subscription_id, {
            discounts: [{ promotion_code: promoCodeId }],
            metadata: {
              promo_code: promoCode
            }
          });
        }

        // Retrieve the existing subscription with expanded fields
        const subscription = await stripe.subscriptions.retrieve(
          session.stripe_subscription_id,
          { expand: ['latest_invoice.payment_intent', 'pending_setup_intent'] }
        );

        console.log('[Onboarding] Retrieved existing subscription:', subscription.id);
        console.log('[Onboarding] Subscription status:', subscription.status);

        // For TRIAL subscriptions, return SetupIntent
        if (subscription.pending_setup_intent) {
          console.log('✅ Returning existing subscription (trial)');
          return res.json({
            success: true,
            subscriptionId: subscription.id,
            clientSecret: subscription.pending_setup_intent.client_secret,
            requiresSetup: true,
            isTrial: true
          });
        }

        // For NON-TRIAL subscriptions, return PaymentIntent
        if (subscription.latest_invoice?.payment_intent?.client_secret) {
          console.log('✅ Returning existing subscription (immediate)');
          return res.json({
            success: true,
            subscriptionId: subscription.id,
            clientSecret: subscription.latest_invoice.payment_intent.client_secret,
            requiresSetup: false,
            isTrial: false
          });
        }

        // If subscription exists but has no intent, fall through to create new one
        console.log('[Onboarding] Existing subscription has no intent, will create new one');
      }

      // Create or retrieve Stripe customer for this session
      let customerId = session.stripe_customer_id;

      if (!customerId) {
        // Create an anonymous customer in Stripe
        const customer = await stripe.customers.create({
          metadata: {
            session_id: sessionId,
            is_onboarding: 'true',
            app: 'fridgy'
          }
        });

        customerId = customer.id;

        // Update session with customer ID
        await supabase
          .from('onboarding_sessions')
          .update({
            stripe_customer_id: customerId,
            updated_at: new Date().toISOString()
          })
          .eq('session_id', sessionId);
      }

      // Prepare subscription data
      const subscriptionData = {
        customer: customerId,
        items: [{ price: priceId }],
        payment_behavior: 'default_incomplete',
        payment_settings: {
          save_default_payment_method: 'on_subscription'
        },
        expand: ['latest_invoice.payment_intent', 'pending_setup_intent'],
        trial_period_days: 7, // 7-day free trial
        metadata: {
          session_id: sessionId,
          is_onboarding: 'true',
          promo_code: promoCode || null
        }
      };

      // Apply promo code if provided (Stripe promotion code)
      if (promoCode) {
        console.log('[Onboarding] Looking up promotion code in Stripe:', promoCode);

        // Look up the promotion code ID from Stripe
        const promoCodes = await stripe.promotionCodes.list({
          code: promoCode,
          active: true,
          limit: 1
        });

        if (promoCodes.data.length === 0) {
          console.error('[Onboarding] Promotion code not found in Stripe:', promoCode);
          throw new Error('Promotion code not found or inactive in Stripe');
        }

        const promoCodeId = promoCodes.data[0].id;
        subscriptionData.discounts = [{ promotion_code: promoCodeId }];
        console.log('[Onboarding] Applying promo code:', promoCode, '→ ID:', promoCodeId);
      }

      // Create subscription
      const subscription = await stripe.subscriptions.create(subscriptionData);

      console.log('[Onboarding] Created subscription:', subscription.id);
      console.log('[Onboarding] Subscription status:', subscription.status);

      // Update session with subscription ID
      await supabase
        .from('onboarding_sessions')
        .update({
          stripe_subscription_id: subscription.id,
          updated_at: new Date().toISOString()
        })
        .eq('session_id', sessionId);

      // For TRIAL subscriptions, return SetupIntent
      if (subscription.pending_setup_intent) {
        // setupIntent is already expanded due to 'expand' parameter in subscription creation
        const setupIntent = subscription.pending_setup_intent;

        console.log('✅ Onboarding payment intent created (trial)');

        return res.json({
          success: true,
          subscriptionId: subscription.id,
          clientSecret: setupIntent.client_secret,
          requiresSetup: true,
          isTrial: true
        });
      }

      // For NON-TRIAL subscriptions, return PaymentIntent
      if (subscription.latest_invoice?.payment_intent?.client_secret) {
        console.log('✅ Onboarding payment intent created (immediate)');

        return res.json({
          success: true,
          subscriptionId: subscription.id,
          clientSecret: subscription.latest_invoice.payment_intent.client_secret,
          requiresSetup: false,
          isTrial: false
        });
      }

      // If we got here, subscription was created but has no payment/setup intent
      // Log detailed information for debugging
      console.error('[Onboarding] Subscription created but missing payment intent:', {
        subscriptionId: subscription.id,
        status: subscription.status,
        hasPendingSetupIntent: !!subscription.pending_setup_intent,
        hasLatestInvoice: !!subscription.latest_invoice,
        hasPaymentIntent: !!subscription.latest_invoice?.payment_intent
      });

      throw new Error(`Subscription created (${subscription.status}) but missing payment intent. Please contact support.`);

    } catch (error) {
      console.error('❌ Error creating payment intent:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to create payment intent',
        message: error.message
      });
    }
  },

  /**
   * Confirm payment completion for onboarding session
   * POST /api/onboarding/confirm-payment
   */
  async confirmOnboardingPayment(req, res) {
    try {
      console.log('✅ Confirming onboarding payment...');

      const { sessionId, paymentIntentId, subscriptionId } = req.body;

      // Detailed logging for debugging
      console.log('[ConfirmPayment] Request body:', {
        sessionId,
        paymentIntentId,
        subscriptionId,
        hasSessionId: !!sessionId,
        hasSubscriptionId: !!subscriptionId
      });

      if (!sessionId || !subscriptionId) {
        console.error('[ConfirmPayment] Missing required fields:', {
          sessionId: !!sessionId,
          subscriptionId: !!subscriptionId
        });
        return res.status(400).json({
          success: false,
          error: 'Session ID and subscription ID required'
        });
      }

      const supabase = getSupabaseClient();

      // Step 1: Query session by session_id ONLY (remove strict filter)
      console.log('[ConfirmPayment] Querying session:', sessionId);
      const { data: session, error: sessionError } = await supabase
        .from('onboarding_sessions')
        .select('*')
        .eq('session_id', sessionId)
        .single();

      // Log what we got from database
      console.log('[ConfirmPayment] Database query result:', {
        found: !!session,
        error: sessionError?.message,
        sessionData: session ? {
          session_id: session.session_id,
          stripe_customer_id: session.stripe_customer_id,
          stripe_subscription_id: session.stripe_subscription_id,
          payment_confirmed: session.payment_confirmed
        } : null
      });

      if (sessionError || !session) {
        console.error('[ConfirmPayment] Session not found:', {
          sessionId,
          error: sessionError?.message
        });
        return res.status(400).json({
          success: false,
          error: 'Session not found'
        });
      }

      // Step 2: Verify subscription ID matches
      if (session.stripe_subscription_id !== subscriptionId) {
        console.error('[ConfirmPayment] Subscription ID mismatch:', {
          sessionId,
          storedSubscriptionId: session.stripe_subscription_id,
          receivedSubscriptionId: subscriptionId,
          match: session.stripe_subscription_id === subscriptionId
        });
        return res.status(400).json({
          success: false,
          error: 'Subscription ID mismatch',
          details: {
            expected: session.stripe_subscription_id,
            received: subscriptionId
          }
        });
      }

      // Step 3: Check if already confirmed
      if (session.payment_confirmed) {
        console.log('[ConfirmPayment] Payment already confirmed for session:', sessionId);
        // Return success anyway - idempotent
        return res.json({
          success: true,
          message: 'Payment already confirmed',
          alreadyConfirmed: true
        });
      }

      // Step 4: Verify payment status with Stripe
      console.log('[ConfirmPayment] Retrieving subscription from Stripe:', subscriptionId);
      const subscription = await stripe.subscriptions.retrieve(subscriptionId);

      console.log('[ConfirmPayment] Stripe subscription status:', {
        id: subscription.id,
        status: subscription.status,
        trial_end: subscription.trial_end,
        current_period_end: subscription.current_period_end,
        default_payment_method: subscription.default_payment_method
      });

      // Only confirm payment if subscription has verified payment method
      const hasPaymentMethod = subscription.default_payment_method != null;

      console.log('[ConfirmPayment] 🔍 Payment method check:', {
        hasPaymentMethod,
        status: subscription.status
      });

      if ((subscription.status === 'trialing' || subscription.status === 'active') && hasPaymentMethod) {
        // Payment confirmed, update session
        await supabase
          .from('onboarding_sessions')
          .update({
            payment_confirmed: true,
            updated_at: new Date().toISOString()
          })
          .eq('session_id', sessionId);

        console.log('✅ Onboarding payment confirmed for session:', sessionId);

        res.json({
          success: true,
          message: 'Payment confirmed',
          subscription: {
            id: subscription.id,
            status: subscription.status,
            trial_end: subscription.trial_end
          }
        });
      } else {
        console.error('[ConfirmPayment] Unexpected subscription status:', {
          subscriptionId,
          status: subscription.status,
          expectedStatuses: ['trialing', 'active']
        });
        res.status(400).json({
          success: false,
          error: 'Payment not confirmed',
          status: subscription.status
        });
      }

    } catch (error) {
      console.error('❌ Error confirming payment:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to confirm payment',
        message: error.message
      });
    }
  },

  /**
   * Validate Promo Code (Public - No Auth Required)
   * Used during onboarding before account creation
   */
  async validatePromoCode(req, res) {
    try {
      const { code } = req.body;

      if (!code) {
        return res.status(400).json({
          success: false,
          valid: false,
          error: 'MISSING_CODE',
          message: 'Promo code is required'
        });
      }

      console.log('[Onboarding] Validating promo code:', code.toUpperCase());

      // Query database for promo code
      const supabase = getSupabaseClient();

      const { data: promoCodes, error: queryError } = await supabase
        .from('promo_codes')
        .select('*')
        .eq('code', code.toUpperCase())
        .eq('active', true)
        .single();

      if (queryError || !promoCodes) {
        console.log('[Onboarding] Promo code not found in database');
        return res.status(404).json({
          success: false,
          valid: false,
          error: 'INVALID_CODE',
          message: 'Promo code is invalid or expired'
        });
      }

      // Check expiration
      if (promoCodes.expires_at && new Date(promoCodes.expires_at) < new Date()) {
        console.log('[Onboarding] Promo code has expired');
        return res.status(404).json({
          success: false,
          valid: false,
          error: 'EXPIRED_CODE',
          message: 'Promo code has expired'
        });
      }

      // Note: max_redemptions is enforced by Stripe, not here
      // Stripe will reject the promo if limit is reached when applying to subscription

      // Code is valid
      console.log('[Onboarding] Promo code is valid:', promoCodes);
      return res.json({
        success: true,
        valid: true,
        promo: {
          code: promoCodes.code,
          discountType: promoCodes.discount_type,
          discountValue: promoCodes.discount_value,
          duration: promoCodes.duration,
          durationInMonths: promoCodes.duration_in_months
        }
      });

    } catch (error) {
      console.error('[Onboarding] Promo validation error:', error);
      return res.status(500).json({
        success: false,
        valid: false,
        error: 'SERVER_ERROR',
        message: 'Failed to validate promo code'
      });
    }
  },

  /**
   * Apply Promo Code to Existing Subscription
   * POST /api/onboarding/apply-promo
   * Updates subscription discount WITHOUT returning new clientSecret
   */
  async applyPromoCode(req, res) {
    try {
      const { sessionId, subscriptionId, promoCode } = req.body;

      if (!sessionId || !subscriptionId || !promoCode) {
        return res.status(400).json({
          success: false,
          error: 'Session ID, subscription ID, and promo code required'
        });
      }

      const supabase = getSupabaseClient();

      // Verify session exists
      const { data: session, error: sessionError } = await supabase
        .from('onboarding_sessions')
        .select('*')
        .eq('session_id', sessionId)
        .single();

      if (sessionError || !session) {
        return res.status(400).json({
          success: false,
          error: 'Session not found'
        });
      }

      // Verify subscription ID matches session
      if (session.stripe_subscription_id !== subscriptionId) {
        return res.status(400).json({
          success: false,
          error: 'Subscription ID mismatch'
        });
      }

      console.log('[Onboarding] Applying promo code to subscription:', promoCode, subscriptionId);

      // Look up the promotion code ID from Stripe
      const promoCodes = await stripe.promotionCodes.list({
        code: promoCode,
        active: true,
        limit: 1
      });

      if (promoCodes.data.length === 0) {
        console.error('[Onboarding] Promotion code not found in Stripe:', promoCode);
        return res.status(404).json({
          success: false,
          error: 'Promotion code not found or inactive in Stripe'
        });
      }

      const promoCodeId = promoCodes.data[0].id;

      // Update existing subscription with the promo discount
      await stripe.subscriptions.update(subscriptionId, {
        discounts: [{ promotion_code: promoCodeId }],
        metadata: {
          promo_code: promoCode
        }
      });

      console.log('[Onboarding] Promo code applied successfully:', promoCode);

      res.json({
        success: true,
        message: 'Promo code applied successfully',
        promoCode: promoCode
      });

    } catch (error) {
      console.error('[Onboarding] Error applying promo code:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to apply promo code',
        message: error.message
      });
    }
  }
};

module.exports = onboardingController;