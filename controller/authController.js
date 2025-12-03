const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { createClient } = require('@supabase/supabase-js');
const authService = require('../services/authService');
const { createDefaultRecipe } = require('../services/defaultRecipe');
const emailService = require('../services/emailService');

// Initialize Supabase client
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// JWT secret
const JWT_SECRET = process.env.JWT_SECRET || 'your-super-secret-jwt-key-change-in-production';
const REFRESH_SECRET = process.env.REFRESH_SECRET || JWT_SECRET + '-refresh';

// Validation functions
const validateEmail = (email) => {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
};

const validatePassword = (password) => {
  return password.length >= 8;
};

const validateName = (name) => {
  const nameRegex = /^[a-zA-Z\s]{2,}$/;
  return nameRegex.test(name.trim());
};

// Generate JWT token (1 hour expiry)
const generateToken = (userId) => {
  return jwt.sign({ userId }, JWT_SECRET, { expiresIn: '1h' });
};

// Generate refresh token (30 days expiry)
const generateRefreshToken = (userId) => {
  return jwt.sign({ userId, type: 'refresh' }, REFRESH_SECRET, { expiresIn: '30d' });
};

// Verify refresh token
const verifyRefreshToken = (token) => {
  try {
    const decoded = jwt.verify(token, REFRESH_SECRET);
    if (decoded.type !== 'refresh') {
      throw new Error('Invalid token type');
    }
    return decoded;
  } catch (error) {
    throw new Error('Invalid refresh token');
  }
};

// Auth Controller Functions
const authController = {
  // Sign up controller
  async signup(req, res) {
    try {
      const { firstName, email, password, onboardingSessionId } = req.body;

      // Validation
      if (!validateName(firstName)) {
        return res.status(400).json({
          success: false,
          error: 'Name must be at least 2 characters long and contain only letters and spaces'
        });
      }

      if (!validateEmail(email)) {
        return res.status(400).json({
          success: false,
          error: 'Please enter a valid email address'
        });
      }

      if (!validatePassword(password)) {
        return res.status(400).json({
          success: false,
          error: 'Password must be at least 8 characters long'
        });
      }

      // Check if user already exists
      const userExists = await authService.userExistsByEmail(email);
      if (userExists) {
        return res.status(400).json({
          success: false,
          error: 'User with this email already exists'
        });
      }

      // Hash password
      const saltRounds = 12;
      const passwordHash = await bcrypt.hash(password, saltRounds);

      // Create new user
      const newUser = await authService.createUser({
        email,
        firstName,
        passwordHash
      });

      // Generate JWT and refresh tokens
      const token = generateToken(newUser.id);
      const refreshToken = generateRefreshToken(newUser.id);

      // Track if payment was successfully linked
      let paymentLinked = false;

      // Link onboarding payment session if provided
      if (onboardingSessionId) {
        try {
          const { createClient } = require('@supabase/supabase-js');
          // Use service key for backend operations to bypass RLS
          const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

          // Get the onboarding session
          const { data: session, error: sessionError } = await supabase
            .from('onboarding_sessions')
            .select('*')
            .eq('session_id', onboardingSessionId)
            .single();

          if (session && !sessionError && session.payment_confirmed) {
            paymentLinked = true;
            // Link the session to the new user
            await supabase
              .from('onboarding_sessions')
              .update({
                linked_user_id: newUser.id,
                updated_at: new Date().toISOString()
              })
              .eq('session_id', onboardingSessionId);

            // Transfer the Stripe subscription to the user
            if (session.stripe_customer_id && session.stripe_subscription_id) {
              // Fetch subscription from Stripe to get trial dates
              const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
              const subscription = await stripe.subscriptions.retrieve(session.stripe_subscription_id);

              // Prepare subscription data with all fields from Stripe
              const subscriptionData = {
                user_id: newUser.id,
                stripe_customer_id: session.stripe_customer_id,
                stripe_subscription_id: session.stripe_subscription_id,
                stripe_price_id: subscription.items.data[0]?.price?.id || null,
                tier: 'premium',
                status: subscription.status || 'trialing',
                trial_start: subscription.trial_start
                  ? new Date(subscription.trial_start * 1000).toISOString()
                  : null,
                trial_end: subscription.trial_end
                  ? new Date(subscription.trial_end * 1000).toISOString()
                  : null,
                current_period_start: subscription.current_period_start
                  ? new Date(subscription.current_period_start * 1000).toISOString()
                  : null,
                current_period_end: subscription.current_period_end
                  ? new Date(subscription.current_period_end * 1000).toISOString()
                  : null,
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString()
              };

              console.log('[Signup] Saving subscription with all Stripe fields:', {
                stripe_price_id: subscriptionData.stripe_price_id,
                trial_start: subscriptionData.trial_start,
                trial_end: subscriptionData.trial_end,
                current_period_start: subscriptionData.current_period_start,
                current_period_end: subscriptionData.current_period_end
              });

              // Create subscription record for the user
              await supabase
                .from('subscriptions')
                .upsert(subscriptionData, { onConflict: 'user_id' });

              // Sync user tier to premium immediately (don't wait for webhook)
              const { error: tierError } = await supabase
                .from('users')
                .update({ tier: 'premium' })
                .eq('id', newUser.id);

              if (tierError) {
                console.error('[Signup] Error updating user tier:', tierError);
                // Don't fail signup - webhook will fix it
              } else {
                console.log('[Signup] User tier updated to premium');
              }

              // Update Stripe customer with user email and name
              await stripe.customers.update(session.stripe_customer_id, {
                email: newUser.email,
                name: newUser.first_name,
                metadata: {
                  user_id: newUser.id,
                  linked: 'true'
                }
              });

              console.log('[Signup] Successfully linked onboarding payment to user:', newUser.id);

              // Send trial start email
              try {
                if (subscription.trial_end) {
                  const trialEndDate = new Date(subscription.trial_end * 1000);

                  console.log('[Signup] Sending trial start email to:', newUser.email);

                  // Send trial start email
                  await emailService.sendTrialStartEmail(
                    {
                      email: newUser.email,
                      first_name: newUser.first_name
                    },
                    trialEndDate
                  );

                  console.log('[Signup] Trial start email sent successfully');
                } else {
                  console.log('[Signup] No trial_end date found, skipping email');
                }
              } catch (emailError) {
                console.error('[Signup] Failed to send trial start email:', emailError.message);
                // Don't fail signup if email fails - user already has account
              }
            }
          }
        } catch (linkError) {
          console.error('[Signup] Error linking onboarding session:', linkError);
          // Don't fail the signup if linking fails - user can contact support
        }
      }

      // Send welcome email to free users (no payment linked)
      // This covers both users who never started onboarding AND users who abandoned it
      if (!paymentLinked) {
        try {
          console.log('[Signup] User signed up as free user, sending welcome email');

          await emailService.sendWelcomeEmail({
            email: newUser.email,
            first_name: newUser.first_name
          });

          console.log('[Signup] Welcome email sent successfully');
        } catch (emailError) {
          console.error('[Signup] Failed to send welcome email:', emailError.message);
          // Don't fail signup if email fails - user already has account
        }
      }

      // Create default welcome recipe for new user (non-blocking)
      createDefaultRecipe(newUser.id).catch(err => {
        console.error('[Signup] Failed to create default recipe for new user:', newUser.id, err);
      });

      // Return success response with tokens
      res.status(201).json({
        success: true,
        message: 'User created successfully',
        user: {
          id: newUser.id,
          email: newUser.email,
          firstName: newUser.first_name,
          createdAt: newUser.created_at,
          hasSeenWelcomeTour: newUser.has_seen_welcome_tour || false,
          tier: newUser.tier || 'free',
          isGrandfathered: newUser.is_grandfathered || false
        },
        token,
        refreshToken
      });

    } catch (error) {
      console.error('Signup error:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to create user'
      });
    }
  },

  // Sign in controller
  async signin(req, res) {
    try {
      const { email, password } = req.body;

      // Validation
      if (!validateEmail(email)) {
        return res.status(400).json({
          success: false,
          error: 'Please enter a valid email address'
        });
      }

      if (!validatePassword(password)) {
        return res.status(400).json({
          success: false,
          error: 'Password must be at least 8 characters long'
        });
      }

      // Find user by email
      const user = await authService.findUserByEmail(email);
      if (!user) {
        return res.status(401).json({
          success: false,
          error: 'Invalid email or password'
        });
      }

      // Check password
      const isPasswordValid = await bcrypt.compare(password, user.password_hash);
      if (!isPasswordValid) {
        return res.status(401).json({
          success: false,
          error: 'Invalid email or password'
        });
      }

      // Generate JWT and refresh tokens
      const token = generateToken(user.id);
      const refreshToken = generateRefreshToken(user.id);

      // Get tour status from user_tours table
      const tourStatus = await authService.getUserTourStatus(user.id, 'welcome');

      // Return success response with tokens
      res.json({
        success: true,
        message: 'Login successful',
        user: {
          id: user.id,
          email: user.email,
          firstName: user.first_name,
          createdAt: user.created_at,
          hasSeenWelcomeTour: user.has_seen_welcome_tour || false,
          tourStatus: tourStatus.status || 'not_started',
          tier: user.tier || 'free',
          isGrandfathered: user.is_grandfathered || false
        },
        token,
        refreshToken
      });

    } catch (error) {
      console.error('Signin error:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to authenticate user'
      });
    }
  },

  // Get current user controller
  async getCurrentUser(req, res) {
    try {
      // User already verified by middleware - req.user is set
      if (!req.user || !req.user.id) {
        return res.status(401).json({
          success: false,
          error: 'User not authenticated'
        });
      }

      // Get fresh user data
      const user = await authService.findUserById(req.user.id);
      if (!user) {
        return res.status(404).json({
          success: false,
          error: 'User not found'
        });
      }

      // Generate fresh tokens for session refresh
      const newToken = generateToken(user.id);
      const newRefreshToken = generateRefreshToken(user.id);

      // Get tour status from user_tours table
      const tourStatus = await authService.getUserTourStatus(user.id, 'welcome');

      // Return user data with fresh tokens
      res.json({
        success: true,
        user: {
          id: user.id,
          email: user.email,
          firstName: user.first_name,
          createdAt: user.created_at,
          hasSeenWelcomeTour: user.has_seen_welcome_tour || false,
          tourStatus: tourStatus.status || 'not_started',
          tier: user.tier || 'free',
          isGrandfathered: user.is_grandfathered || false
        },
        token: newToken,
        refreshToken: newRefreshToken
      });

    } catch (error) {
      console.error('Get user error:', error);
      res.status(500).json({
        success: false,
        error: 'Server error while fetching user'
      });
    }
  },

  // Refresh token controller
  async refreshToken(req, res) {
    try {
      const { refreshToken } = req.body;

      if (!refreshToken) {
        return res.status(401).json({
          success: false,
          error: 'No refresh token provided'
        });
      }

      // Verify refresh token
      let decoded;
      try {
        decoded = verifyRefreshToken(refreshToken);
      } catch (error) {
        return res.status(401).json({
          success: false,
          error: 'Invalid or expired refresh token'
        });
      }

      // Get user to ensure they still exist
      const user = await authService.findUserById(decoded.userId);
      if (!user) {
        return res.status(401).json({
          success: false,
          error: 'User not found'
        });
      }

      // Generate new tokens
      const newToken = generateToken(user.id);
      const newRefreshToken = generateRefreshToken(user.id);

      res.json({
        success: true,
        token: newToken,
        refreshToken: newRefreshToken,
        user: {
          id: user.id,
          email: user.email,
          firstName: user.first_name,
          createdAt: user.created_at,
          tier: user.tier || 'free',
          isGrandfathered: user.is_grandfathered || false
        }
      });

    } catch (error) {
      console.error('Refresh token error:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to refresh token'
      });
    }
  },

  // Logout controller
  async logout(req, res) {
    try {
      // For JWT tokens, we can't actually invalidate them server-side without
      // implementing a blacklist. For now, we'll just return success and let
      // the client handle clearing the token.
      // In a production app, you might want to:
      // 1. Add token to a blacklist table in database
      // 2. Check blacklist in auth middleware
      // 3. Or use shorter JWT expiration with refresh tokens

      res.json({
        success: true,
        message: 'Logout successful'
      });

    } catch (error) {
      console.error('Logout error:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to logout'
      });
    }
  },

  // Mark welcome tour as completed (DEPRECATED - use markTourComplete instead)
  async markWelcomeTourComplete(req, res) {
    try {
      const userId = req.user.id;

      const { data: user, error } = await supabase
        .from('users')
        .update({
          has_seen_welcome_tour: true,
          tour_status: 'completed',
          tour_completed_at: new Date().toISOString()
        })
        .eq('id', userId)
        .select()
        .single();

      if (error) {
        throw error;
      }

      res.json({
        success: true,
        message: 'Welcome tour marked as completed',
        hasSeenWelcomeTour: true
      });

    } catch (error) {
      console.error('Mark welcome tour error:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to update welcome tour status'
      });
    }
  },

  // Mark tour as started (creates or updates tour record)
  async markTourStart(req, res) {
    try {
      const userId = req.user.id;
      const tourType = req.body.tour_type || 'welcome';

      // Check if tour record already exists
      const { data: existingTour } = await supabase
        .from('user_tours')
        .select('*')
        .eq('user_id', userId)
        .eq('tour_type', tourType)
        .single();

      let tourData;

      if (existingTour) {
        // Update existing tour to in_progress
        const { data, error } = await supabase
          .from('user_tours')
          .update({
            status: 'in_progress',
            started_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
          })
          .eq('user_id', userId)
          .eq('tour_type', tourType)
          .select()
          .single();

        if (error) throw error;
        tourData = data;
      } else {
        // Create new tour record
        const { data, error } = await supabase
          .from('user_tours')
          .insert({
            user_id: userId,
            tour_type: tourType,
            status: 'in_progress',
            started_at: new Date().toISOString(),
            source: 'auto'
          })
          .select()
          .single();

        if (error) throw error;
        tourData = data;
      }

      res.json({
        success: true,
        tour_status: tourData.status,
        tour_started_at: tourData.started_at
      });

    } catch (error) {
      console.error('Mark tour start error:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to mark tour start'
      });
    }
  },

  // Mark tour as completed
  async markTourComplete(req, res) {
    try {
      const userId = req.user.id;
      const { final_step, tour_type = 'welcome' } = req.body;

      // Get existing tour record to calculate duration
      const { data: existingTour } = await supabase
        .from('user_tours')
        .select('*')
        .eq('user_id', userId)
        .eq('tour_type', tour_type)
        .single();

      const now = new Date().toISOString();
      const duration = existingTour?.started_at
        ? Math.round((new Date(now) - new Date(existingTour.started_at)) / 1000)
        : null;

      const { data: tourData, error } = await supabase
        .from('user_tours')
        .update({
          status: 'completed',
          completed_at: now,
          final_step: final_step || 'unknown',
          updated_at: now
        })
        .eq('user_id', userId)
        .eq('tour_type', tour_type)
        .select()
        .single();

      if (error) {
        throw error;
      }

      // Also update has_seen_welcome_tour for backwards compatibility
      if (tour_type === 'welcome') {
        await supabase
          .from('users')
          .update({ has_seen_welcome_tour: true })
          .eq('id', userId);
      }

      console.log(`[Tour Analytics] User ${userId} completed ${tour_type} tour in ${duration}s, final step: ${final_step}`);

      res.json({
        success: true,
        tour_status: tourData.status,
        tour_completed_at: tourData.completed_at,
        duration_seconds: duration
      });

    } catch (error) {
      console.error('Mark tour complete error:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to mark tour complete'
      });
    }
  },

  // Mark tour as skipped/dismissed
  async markTourSkipped(req, res) {
    try {
      const userId = req.user.id;
      const { current_step, reason, tour_type = 'welcome' } = req.body;

      // Get existing tour record to calculate duration before abandonment
      const { data: existingTour } = await supabase
        .from('user_tours')
        .select('*')
        .eq('user_id', userId)
        .eq('tour_type', tour_type)
        .single();

      const now = new Date().toISOString();
      const duration = existingTour?.started_at
        ? Math.round((new Date(now) - new Date(existingTour.started_at)) / 1000)
        : null;

      let tourData;

      if (existingTour) {
        // Update existing tour record
        const { data, error } = await supabase
          .from('user_tours')
          .update({
            status: 'skipped',
            abandoned_at: now,
            final_step: current_step || 'unknown',
            skip_reason: reason || 'user_action',
            updated_at: now
          })
          .eq('user_id', userId)
          .eq('tour_type', tour_type)
          .select()
          .single();

        if (error) throw error;
        tourData = data;
      } else {
        // Create new tour record with skipped status (user skipped from welcome screen)
        const { data, error } = await supabase
          .from('user_tours')
          .insert({
            user_id: userId,
            tour_type: tour_type,
            status: 'skipped',
            abandoned_at: now,
            final_step: current_step || 'welcome_screen',
            skip_reason: reason || 'user_action',
            source: 'auto'
          })
          .select()
          .single();

        if (error) throw error;
        tourData = data;
      }

      // Also update has_seen_welcome_tour for backwards compatibility
      if (tour_type === 'welcome') {
        await supabase
          .from('users')
          .update({ has_seen_welcome_tour: true })
          .eq('id', userId);
      }

      console.log(`[Tour Analytics] User ${userId} skipped ${tour_type} tour at step: ${current_step}, duration: ${duration}s, reason: ${reason || 'user_action'}`);

      res.json({
        success: true,
        tour_status: tourData.status,
        tour_abandoned_at: tourData.abandoned_at,
        duration_seconds: duration
      });

    } catch (error) {
      console.error('Mark tour skipped error:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to mark tour skipped'
      });
    }
  }
};

module.exports = authController;