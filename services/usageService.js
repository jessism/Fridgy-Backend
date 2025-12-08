/**
 * Usage Service
 * Handles usage tracking and limit enforcement for free tier users
 */

const { getServiceClient } = require('../config/supabase');

/**
 * Get feature limits for a given tier
 * @param {string} tier - User tier ('free', 'premium', or 'grandfathered')
 * @returns {Object} Limit configuration
 */
function getLimitsForTier(tier) {
  const limits = {
    free: {
      grocery_items: 20,
      imported_recipes: 10,
      uploaded_recipes: 10,
      meal_logs: Infinity, // Unlimited - historical tracking shouldn't be limited
      owned_shopping_lists: 5,
      joined_shopping_lists: 1,
      joined_cookbooks: 1, // 1 joined cookbook for free tier
      ai_recipes: 3, // 3 generations per month (9 recipes total)
      analytics: false, // Not allowed
    },
    premium: {
      grocery_items: Infinity,
      imported_recipes: Infinity,
      uploaded_recipes: Infinity,
      meal_logs: Infinity,
      owned_shopping_lists: Infinity,
      joined_shopping_lists: Infinity,
      joined_cookbooks: Infinity,
      ai_recipes: Infinity,
      analytics: true,
    },
    grandfathered: {
      // Same as premium (lifetime free premium)
      grocery_items: Infinity,
      imported_recipes: Infinity,
      uploaded_recipes: Infinity,
      meal_logs: Infinity,
      owned_shopping_lists: Infinity,
      joined_shopping_lists: Infinity,
      joined_cookbooks: Infinity,
      ai_recipes: Infinity,
      analytics: true,
    },
  };

  return limits[tier] || limits.free;
}

/**
 * Map feature names to actual database column names
 * Handles special cases like ai_recipes -> ai_recipe_generations_count
 * @param {string} feature - Feature name
 * @returns {string} Database column name
 */
function getColumnName(feature) {
  const columnMapping = {
    'ai_recipes': 'ai_recipe_generations_count',
    // All others follow the pattern: {feature}_count
  };

  return columnMapping[feature] || `${feature}_count`;
}

/**
 * Get user's current usage statistics
 * @param {string} userId - User ID
 * @returns {Promise<Object>} Usage statistics
 */
async function getUserUsage(userId) {
  try {
    const supabase = getServiceClient();

    // Get user tier
    const { data: userData, error: userError } = await supabase
      .from('users')
      .select('tier')
      .eq('id', userId)
      .single();

    if (userError) {
      console.error('[UsageService] Error getting user:', userError);
      throw userError;
    }

    if (!userData) {
      throw new Error('User not found');
    }

    // Get usage limits directly
    const { data: usageLimits, error: usageError } = await supabase
      .from('usage_limits')
      .select('*')
      .eq('user_id', userId)
      .single();

    if (usageError && usageError.code !== 'PGRST116') { // PGRST116 = no rows
      console.error('[UsageService] Error getting usage limits:', usageError);
      throw usageError;
    }

    const tier = userData.tier || 'free';
    const limits = getLimitsForTier(tier);
    const usage = usageLimits || {};

    // Calculate next reset date (rolling 30 days)
    const nextResetDate = usage.last_reset_at
      ? new Date(new Date(usage.last_reset_at).getTime() + 30 * 24 * 60 * 60 * 1000)
      : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

    return {
      tier,
      limits,
      current: {
        grocery_items_count: usage.grocery_items_count || 0,
        imported_recipes_count: usage.imported_recipes_count || 0,
        uploaded_recipes_count: usage.uploaded_recipes_count || 0,
        meal_logs_count: usage.meal_logs_count || 0,
        owned_shopping_lists_count: usage.owned_shopping_lists_count || 0,
        joined_shopping_lists_count: usage.joined_shopping_lists_count || 0,
        ai_recipe_generations_count: usage.ai_recipe_generations_count || 0,
      },
      last_reset_at: usage.last_reset_at,
      next_reset_date: nextResetDate.toISOString(),
    };
  } catch (error) {
    console.error('[UsageService] Error getting user usage:', error);
    throw error;
  }
}

/**
 * Check if user can perform an action based on their tier limits
 * @param {string} userId - User ID
 * @param {string} feature - Feature name (e.g., 'grocery_items', 'imported_recipes')
 * @returns {Promise<Object>} {allowed: boolean, current: number, limit: number, tier: string}
 */
async function checkLimit(userId, feature) {
  try {
    const supabase = getServiceClient();

    // Get user tier
    const { data: userData, error: userError } = await supabase
      .from('users')
      .select('tier')
      .eq('id', userId)
      .single();

    if (userError) {
      console.error('[UsageService] Error fetching user:', userError);
      throw userError;
    }

    if (!userData) {
      throw new Error('User not found');
    }

    let tier = userData.tier || 'free';

    // SAFEGUARD: Check if user has active subscription but tier is 'free'
    // This handles cases where webhooks failed or were delayed
    if (tier === 'free') {
      const { data: subscription, error: subError } = await supabase
        .from('subscriptions')
        .select('tier, status')
        .eq('user_id', userId)
        .single();

      if (subError && subError.code !== 'PGRST116') {
        console.error('[UsageService] Error checking subscription:', subError);
        // Don't throw - proceed with free tier to avoid blocking user
      } else if (subscription && (subscription.status === 'active' || subscription.status === 'trialing')) {
        // User has active subscription but tier is out of sync - fix it!
        console.warn(`[UsageService] TIER MISMATCH DETECTED for user ${userId}: users.tier='${tier}' but subscription.tier='${subscription.tier}' and status='${subscription.status}'`);
        console.warn(`[UsageService] Auto-syncing tier to '${subscription.tier}'`);

        const { error: updateError } = await supabase
          .from('users')
          .update({ tier: subscription.tier })
          .eq('id', userId);

        if (updateError) {
          console.error('[UsageService] Failed to auto-sync tier:', updateError);
          // Don't throw - continue with subscription tier for this request
        } else {
          console.log(`[UsageService] ✅ Auto-synced tier to '${subscription.tier}' for user ${userId}`);
        }

        // Use the subscription tier for this check
        tier = subscription.tier;
      }
    }

    // Get usage limits directly (not via relation)
    const { data: usageLimits, error: usageError } = await supabase
      .from('usage_limits')
      .select('*')
      .eq('user_id', userId)
      .single();

    if (usageError && usageError.code !== 'PGRST116') { // PGRST116 = no rows
      console.error('[UsageService] Error fetching usage limits:', usageError);
      throw usageError;
    }

    const limits = getLimitsForTier(tier);
    let usage = usageLimits || {};
    let current = usage[getColumnName(feature)] || 0;
    const limit = limits[feature];

    // Special case: analytics is a boolean gate (premium only)
    if (feature === 'analytics') {
      return {
        allowed: tier === 'premium' || tier === 'grandfathered',
        current: null,
        limit: null,
        tier,
        premiumRequired: true,
      };
    }

    // Rolling 30-day reset logic for free tier
    if (tier === 'free' && usage.last_reset_at) {
      const lastReset = new Date(usage.last_reset_at);
      const daysSinceReset = (Date.now() - lastReset.getTime()) / (1000 * 60 * 60 * 24);

      if (daysSinceReset >= 30) {
        console.log(`[UsageService] Auto-resetting usage for user ${userId} (${Math.floor(daysSinceReset)} days since last reset)`);

        // Reset all counters
        const { error: resetError } = await supabase
          .from('usage_limits')
          .update({
            grocery_items_count: 0,
            imported_recipes_count: 0,
            uploaded_recipes_count: 0,
            owned_shopping_lists_count: 0,
            joined_shopping_lists_count: 0,
            ai_recipe_generations_count: 0,
            last_reset_at: new Date().toISOString()
          })
          .eq('user_id', userId);

        if (resetError) {
          console.error('[UsageService] Error auto-resetting usage:', resetError);
        } else {
          console.log('[UsageService] ✅ Usage counters reset successfully');
          current = 0; // Update current count after reset
        }
      }
    }

    // Calculate next reset date for response
    const nextResetDate = usage.last_reset_at
      ? new Date(new Date(usage.last_reset_at).getTime() + 30 * 24 * 60 * 60 * 1000)
      : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

    return {
      allowed: current < limit,
      current,
      limit,
      tier,
      nextResetDate: nextResetDate.toISOString(),
    };
  } catch (error) {
    console.error('[UsageService] Error checking limit:', error);
    throw error;
  }
}

/**
 * Increment usage counter for a feature
 * @param {string} userId - User ID
 * @param {string} feature - Feature name
 * @returns {Promise<void>}
 */
async function incrementUsage(userId, feature) {
  try {
    const supabase = getServiceClient();

    // First check if record exists
    const { data: existing, error: checkError } = await supabase
      .from('usage_limits')
      .select('*')
      .eq('user_id', userId)
      .single();

    if (checkError && checkError.code !== 'PGRST116') { // PGRST116 = no rows
      console.error('[UsageService] Error checking existing usage:', checkError);
      throw checkError;
    }

    if (!existing) {
      // Create new record with count of 1
      const columnName = getColumnName(feature);
      const newRecord = {
        user_id: userId,
        [columnName]: 1
      };
      const { error: insertError } = await supabase
        .from('usage_limits')
        .insert(newRecord);

      if (insertError) {
        console.error('[UsageService] Error creating usage record:', insertError);
        throw insertError;
      }
    } else {
      // Increment existing count
      const columnName = getColumnName(feature);
      const currentCount = existing[columnName] || 0;
      const { error: updateError } = await supabase
        .from('usage_limits')
        .update({ [columnName]: currentCount + 1 })
        .eq('user_id', userId);

      if (updateError) {
        console.error('[UsageService] Error updating usage:', updateError);
        throw updateError;
      }
    }

    console.log(`[UsageService] Incremented ${feature} for user:`, userId);
  } catch (error) {
    console.error('[UsageService] Error incrementing usage:', error);
    throw error;
  }
}

/**
 * Decrement usage counter for a feature (e.g., when user deletes an item)
 * @param {string} userId - User ID
 * @param {string} feature - Feature name
 * @returns {Promise<void>}
 */
async function decrementUsage(userId, feature) {
  try {
    const supabase = getServiceClient();
    const columnName = getColumnName(feature);

    // Get current count
    const { data: existing, error: getError } = await supabase
      .from('usage_limits')
      .select(columnName)
      .eq('user_id', userId)
      .single();

    if (getError && getError.code !== 'PGRST116') {
      console.error('[UsageService] Error getting current usage:', getError);
      throw getError;
    }

    if (existing) {
      const currentCount = existing[columnName] || 0;
      const newCount = Math.max(0, currentCount - 1); // Never go below 0

      const { error: updateError } = await supabase
        .from('usage_limits')
        .update({ [columnName]: newCount })
        .eq('user_id', userId);

      if (updateError) {
        console.error('[UsageService] Error decrementing usage:', updateError);
        throw updateError;
      }
    }

    console.log(`[UsageService] Decremented ${feature} for user:`, userId);
  } catch (error) {
    console.error('[UsageService] Error decrementing usage:', error);
    throw error;
  }
}

/**
 * Sync usage counts with actual database records (safety check)
 * This should be run periodically as a cron job or on-demand
 * @param {string} userId - User ID
 * @returns {Promise<Object>} Updated usage counts
 */
async function syncUsageCounts(userId) {
  try {
    const supabase = getServiceClient();

    // Calculate actual counts from database
    const { count: groceryCount } = await supabase
      .from('fridge_items')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', userId);

    const { count: importedRecipesCount } = await supabase
      .from('saved_recipes')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', userId)
      .eq('source_type', 'instagram');

    const { count: uploadedRecipesCount } = await supabase
      .from('saved_recipes')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', userId)
      .in('source_type', ['manual', null]);

    const { count: mealsCount } = await supabase
      .from('meal_logs')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', userId);

    const { count: ownedListsCount } = await supabase
      .from('shopping_lists')
      .select('*', { count: 'exact', head: true })
      .eq('owner_id', userId);

    // For joined lists, need to get members where user is not the owner
    const { data: memberLists } = await supabase
      .from('shopping_list_members')
      .select('list_id')
      .eq('user_id', userId);

    const { data: ownedLists } = await supabase
      .from('shopping_lists')
      .select('id')
      .eq('owner_id', userId);

    const ownedListIds = ownedLists?.map(l => l.id) || [];
    const memberListIds = memberLists?.map(m => m.list_id) || [];
    const joinedListsCount = memberListIds.filter(id => !ownedListIds.includes(id)).length;

    // Update or create usage_limits record
    const updateData = {
      user_id: userId,
      grocery_items_count: groceryCount || 0,
      imported_recipes_count: importedRecipesCount || 0,
      uploaded_recipes_count: uploadedRecipesCount || 0,
      meal_logs_count: mealsCount || 0,
      owned_shopping_lists_count: ownedListsCount || 0,
      joined_shopping_lists_count: joinedListsCount,
    };

    const { error } = await supabase
      .from('usage_limits')
      .upsert(updateData, { onConflict: 'user_id' });

    if (error) {
      console.error('[UsageService] Error updating usage counts:', error);
      throw error;
    }

    console.log('[UsageService] Synced usage counts for user:', userId);

    return {
      grocery_items: groceryCount || 0,
      imported_recipes: importedRecipesCount || 0,
      uploaded_recipes: uploadedRecipesCount || 0,
      meal_logs: mealsCount || 0,
      owned_shopping_lists: ownedListsCount || 0,
      joined_shopping_lists: joinedListsCount,
    };
  } catch (error) {
    console.error('[UsageService] Error syncing usage counts:', error);
    throw error;
  }
}

/**
 * Reset usage counters (for testing or manual admin actions)
 * @param {string} userId - User ID
 * @returns {Promise<void>}
 */
async function resetUsage(userId) {
  try {
    const supabase = getServiceClient();

    const { error } = await supabase
      .from('usage_limits')
      .update({
        grocery_items_count: 0,
        imported_recipes_count: 0,
        uploaded_recipes_count: 0,
        meal_logs_count: 0,
        owned_shopping_lists_count: 0,
        joined_shopping_lists_count: 0,
        ai_recipe_generations_count: 0,
        last_reset_at: new Date().toISOString()
      })
      .eq('user_id', userId);

    if (error) {
      console.error('[UsageService] Error resetting usage:', error);
      throw error;
    }

    console.log('[UsageService] Reset usage for user:', userId);
  } catch (error) {
    console.error('[UsageService] Error resetting usage:', error);
    throw error;
  }
}

module.exports = {
  getLimitsForTier,
  getUserUsage,
  checkLimit,
  incrementUsage,
  decrementUsage,
  syncUsageCounts,
  resetUsage,
};
