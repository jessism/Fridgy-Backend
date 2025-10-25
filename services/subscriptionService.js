/**
 * Subscription Service
 * Manages subscription state in the database (synced from Stripe webhooks)
 */

const { getServiceClient } = require('../config/supabase');

/**
 * Get user's subscription status
 * @param {string} userId - User ID
 * @returns {Promise<Object|null>} Subscription object or null
 */
async function getUserSubscription(userId) {
  try {
    const supabase = getServiceClient();

    // First get user data with subscription info
    const { data: userData, error: userError } = await supabase
      .from('users')
      .select(`
        id,
        tier,
        is_grandfathered,
        subscriptions (
          id,
          user_id,
          stripe_customer_id,
          stripe_subscription_id,
          stripe_price_id,
          tier,
          status,
          trial_start,
          trial_end,
          current_period_start,
          current_period_end,
          cancel_at_period_end,
          canceled_at,
          created_at,
          updated_at
        )
      `)
      .eq('id', userId)
      .single();

    if (userError) {
      console.error('[SubscriptionService] Error getting user data:', userError);
      throw userError;
    }

    if (!userData) {
      return null;
    }

    // Get subscription directly (relational query is unreliable)
    const { data: subscription, error: subError } = await supabase
      .from('subscriptions')
      .select('*')
      .eq('user_id', userId)
      .single();

    if (subError && subError.code !== 'PGRST116') { // PGRST116 = no rows
      console.error('[SubscriptionService] Error getting subscription:', subError);
      throw subError;
    }

    // If no subscription record, user is free tier
    if (!subscription) {
      return {
        tier: userData.tier || 'free',
        status: null,
        is_grandfathered: userData.is_grandfathered || false,
      };
    }

    // Return subscription data
    return {
      ...subscription,
      tier: subscription.tier || userData.tier || 'free',
      is_grandfathered: userData.is_grandfathered || false,
    };
  } catch (error) {
    console.error('[SubscriptionService] Error getting subscription:', error);
    throw error;
  }
}

/**
 * Create or update subscription from Stripe data
 * @param {Object} subscriptionData - Stripe subscription object
 * @returns {Promise<Object>} Created/updated subscription
 */
async function upsertSubscription(subscriptionData) {
  try {
    const supabase = getServiceClient();
    const {
      userId,
      stripeCustomerId,
      stripeSubscriptionId,
      stripePriceId,
      tier,
      status,
      trialStart,
      trialEnd,
      currentPeriodStart,
      currentPeriodEnd,
      cancelAtPeriodEnd,
      canceledAt,
    } = subscriptionData;

    // Use upsert for create or update
    const { data: subscription, error } = await supabase
      .from('subscriptions')
      .upsert({
        user_id: userId,
        stripe_customer_id: stripeCustomerId,
        stripe_subscription_id: stripeSubscriptionId,
        stripe_price_id: stripePriceId,
        tier: tier,
        status: status,
        trial_start: trialStart,
        trial_end: trialEnd,
        current_period_start: currentPeriodStart,
        current_period_end: currentPeriodEnd,
        cancel_at_period_end: cancelAtPeriodEnd,
        canceled_at: canceledAt,
        updated_at: new Date().toISOString()
      }, {
        onConflict: 'user_id'
      })
      .select()
      .single();

    if (error) {
      console.error('[SubscriptionService] Error upserting subscription:', error);
      throw error;
    }

    // Also update user tier
    const { error: userError } = await supabase
      .from('users')
      .update({ tier: tier })
      .eq('id', userId);

    if (userError) {
      console.error('[SubscriptionService] Error updating user tier:', userError);
      throw userError;
    }

    console.log('[SubscriptionService] Upserted subscription for user:', userId, 'tier:', tier);

    return subscription;
  } catch (error) {
    console.error('[SubscriptionService] Error upserting subscription:', error);
    throw error;
  }
}

/**
 * Update subscription status
 * @param {string} stripeSubscriptionId - Stripe subscription ID
 * @param {string} status - New status
 * @returns {Promise<Object>} Updated subscription
 */
async function updateSubscriptionStatus(stripeSubscriptionId, status) {
  try {
    const supabase = getServiceClient();

    const { data: subscription, error } = await supabase
      .from('subscriptions')
      .update({
        status: status,
        updated_at: new Date().toISOString()
      })
      .eq('stripe_subscription_id', stripeSubscriptionId)
      .select()
      .single();

    if (error) {
      console.error('[SubscriptionService] Error updating status:', error);
      throw error;
    }

    if (!subscription) {
      throw new Error(`Subscription not found: ${stripeSubscriptionId}`);
    }

    console.log('[SubscriptionService] Updated status for subscription:', stripeSubscriptionId, 'to:', status);

    return subscription;
  } catch (error) {
    console.error('[SubscriptionService] Error updating status:', error);
    throw error;
  }
}

/**
 * Mark subscription as canceled
 * @param {string} stripeSubscriptionId - Stripe subscription ID
 * @returns {Promise<Object>} Updated subscription
 */
async function cancelSubscription(stripeSubscriptionId) {
  try {
    const supabase = getServiceClient();

    const { data: subscription, error } = await supabase
      .from('subscriptions')
      .update({
        status: 'canceled',
        canceled_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      })
      .eq('stripe_subscription_id', stripeSubscriptionId)
      .select()
      .single();

    if (error) {
      console.error('[SubscriptionService] Error canceling subscription:', error);
      throw error;
    }

    if (!subscription) {
      throw new Error(`Subscription not found: ${stripeSubscriptionId}`);
    }

    console.log('[SubscriptionService] Canceled subscription:', stripeSubscriptionId);

    return subscription;
  } catch (error) {
    console.error('[SubscriptionService] Error canceling subscription:', error);
    throw error;
  }
}

/**
 * Downgrade user to free tier
 * @param {string} userId - User ID
 * @returns {Promise<void>}
 */
async function downgradeToFree(userId) {
  try {
    const supabase = getServiceClient();

    // Update user tier
    const { error: userError } = await supabase
      .from('users')
      .update({ tier: 'free' })
      .eq('id', userId);

    if (userError) {
      console.error('[SubscriptionService] Error updating user tier:', userError);
      throw userError;
    }

    // Update subscription status
    const { error: subError } = await supabase
      .from('subscriptions')
      .update({
        tier: 'free',
        status: 'canceled',
        updated_at: new Date().toISOString()
      })
      .eq('user_id', userId);

    if (subError) {
      console.error('[SubscriptionService] Error updating subscription:', subError);
      throw subError;
    }

    console.log('[SubscriptionService] Downgraded user to free tier:', userId);
  } catch (error) {
    console.error('[SubscriptionService] Error downgrading user:', error);
    throw error;
  }
}

/**
 * Get subscription by Stripe subscription ID
 * @param {string} stripeSubscriptionId - Stripe subscription ID
 * @returns {Promise<Object|null>} Subscription or null
 */
async function getSubscriptionByStripeId(stripeSubscriptionId) {
  try {
    const supabase = getServiceClient();

    const { data: subscription, error } = await supabase
      .from('subscriptions')
      .select('*')
      .eq('stripe_subscription_id', stripeSubscriptionId)
      .single();

    if (error && error.code !== 'PGRST116') { // PGRST116 = no rows found
      console.error('[SubscriptionService] Error getting subscription by Stripe ID:', error);
      throw error;
    }

    return subscription || null;
  } catch (error) {
    console.error('[SubscriptionService] Error getting subscription by Stripe ID:', error);
    throw error;
  }
}

/**
 * Get subscription by Stripe customer ID
 * @param {string} stripeCustomerId - Stripe customer ID
 * @returns {Promise<Object|null>} Subscription or null
 */
async function getSubscriptionByCustomerId(stripeCustomerId) {
  try {
    const supabase = getServiceClient();

    const { data: subscription, error } = await supabase
      .from('subscriptions')
      .select('*')
      .eq('stripe_customer_id', stripeCustomerId)
      .single();

    if (error && error.code !== 'PGRST116') { // PGRST116 = no rows found
      console.error('[SubscriptionService] Error getting subscription by customer ID:', error);
      throw error;
    }

    return subscription || null;
  } catch (error) {
    console.error('[SubscriptionService] Error getting subscription by customer ID:', error);
    throw error;
  }
}

/**
 * Check if user is premium (includes grandfathered)
 * @param {string} userId - User ID
 * @returns {Promise<boolean>} True if premium or grandfathered
 */
async function isPremium(userId) {
  try {
    const supabase = getServiceClient();

    const { data: user, error } = await supabase
      .from('users')
      .select('tier')
      .eq('id', userId)
      .single();

    if (error && error.code !== 'PGRST116') { // PGRST116 = no rows found
      console.error('[SubscriptionService] Error checking premium status:', error);
      throw error;
    }

    if (!user) {
      return false;
    }

    return user.tier === 'premium' || user.tier === 'grandfathered';
  } catch (error) {
    console.error('[SubscriptionService] Error checking premium status:', error);
    throw error;
  }
}

/**
 * Get all active subscriptions (for admin/metrics)
 * @returns {Promise<Array>} Array of active subscriptions
 */
async function getActiveSubscriptions() {
  try {
    const supabase = getServiceClient();

    const { data: subscriptions, error } = await supabase
      .from('subscriptions')
      .select(`
        *,
        users!inner (
          email,
          first_name
        )
      `)
      .in('status', ['active', 'trialing'])
      .order('created_at', { ascending: false });

    if (error) {
      console.error('[SubscriptionService] Error getting active subscriptions:', error);
      throw error;
    }

    // Flatten the response to match expected format
    const formattedSubscriptions = (subscriptions || []).map(sub => ({
      ...sub,
      email: sub.users?.email,
      first_name: sub.users?.first_name
    }));

    return formattedSubscriptions;
  } catch (error) {
    console.error('[SubscriptionService] Error getting active subscriptions:', error);
    throw error;
  }
}

/**
 * Get subscription metrics (for admin dashboard)
 * @returns {Promise<Object>} Subscription metrics
 */
async function getSubscriptionMetrics() {
  try {
    const supabase = getServiceClient();

    // Get all users with their subscription info
    const { data: users, error: usersError } = await supabase
      .from('users')
      .select(`
        tier,
        subscriptions (
          status,
          cancel_at_period_end
        )
      `);

    if (usersError) {
      console.error('[SubscriptionService] Error getting users for metrics:', usersError);
      throw usersError;
    }

    // Calculate metrics from the data
    const metrics = {
      free_users: 0,
      premium_users: 0,
      grandfathered_users: 0,
      trial_users: 0,
      active_subscriptions: 0,
      past_due_subscriptions: 0,
      pending_cancellations: 0
    };

    users?.forEach(user => {
      // Count user tiers
      if (user.tier === 'free') metrics.free_users++;
      if (user.tier === 'premium') metrics.premium_users++;
      if (user.tier === 'grandfathered') metrics.grandfathered_users++;

      // Count subscription statuses
      if (user.subscriptions && user.subscriptions.length > 0) {
        const sub = user.subscriptions[0];
        if (sub.status === 'trialing') metrics.trial_users++;
        if (sub.status === 'active') metrics.active_subscriptions++;
        if (sub.status === 'past_due') metrics.past_due_subscriptions++;
        if (sub.cancel_at_period_end === true) metrics.pending_cancellations++;
      }
    });

    return metrics;
  } catch (error) {
    console.error('[SubscriptionService] Error getting metrics:', error);
    throw error;
  }
}

module.exports = {
  getUserSubscription,
  upsertSubscription,
  updateSubscriptionStatus,
  cancelSubscription,
  downgradeToFree,
  getSubscriptionByStripeId,
  getSubscriptionByCustomerId,
  isPremium,
  getActiveSubscriptions,
  getSubscriptionMetrics,
};
