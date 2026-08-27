/**
 * Tier Sync Service
 * One place for taking premium away from an Apple/RevenueCat subscriber. Shared by
 * the RevenueCat webhook (EXPIRATION, past-expiry CANCELLATION, TRANSFER) and the
 * nightly IAP reconcile sweep, plus the cache invalidation every tier write needs.
 */

const { getServiceClient } = require('../config/supabase');
const usageService = require('./usageService');
const voiceAccessService = require('./voiceAccessService');

/**
 * Drop every per-process cache that embeds users.tier. Call after any tier write,
 * otherwise limits and voice access keep the old tier for up to 5 minutes.
 * @param {string} userId
 */
function invalidateTierCaches(userId) {
  usageService.invalidateUserCache(userId);
  voiceAccessService.invalidate(userId);
  console.log(`[TierSync] Invalidated tier caches for user ${userId}`);
}

/**
 * Downgrade an IAP user to free unless a guard says otherwise. Grandfathered users
 * and users with an active/trialing Stripe subscription keep premium.
 *
 * @param {string} email - lowercased, trimmed
 * @param {Object} [options]
 * @param {string} [options.reason] - for logs only, e.g. 'EXPIRATION' | 'TRANSFER'
 * @param {boolean} [options.dryRun] - report what would happen, write nothing
 * @returns {Promise<{status: string, userId?: string, previousTier?: string, error?: string}>}
 *   status: 'downgraded' | 'would_downgrade' | 'already_free' | 'grandfathered_skip'
 *         | 'stripe_active_skip' | 'user_not_found' | 'error'
 */
async function downgradeUserIfEligible(email, { reason = 'downgrade', dryRun = false } = {}) {
  const supabase = getServiceClient();

  const { data: user, error: userError } = await supabase
    .from('users')
    .select('id, tier, is_grandfathered')
    .eq('email', email)
    .maybeSingle();

  if (userError) {
    console.error(`[TierSync] Lookup failed for ${email}:`, userError.message);
    return { status: 'error', error: userError.message };
  }
  if (!user) {
    console.warn(`[TierSync] User not found for downgrade: ${email}`);
    return { status: 'user_not_found' };
  }

  if (user.is_grandfathered) {
    console.log(`[TierSync] ${email} is grandfathered - keeping premium (${reason})`);
    return { status: 'grandfathered_skip', userId: user.id };
  }

  if (user.tier === 'free') {
    return { status: 'already_free', userId: user.id };
  }

  // subscriptions.user_id is UNIQUE, so this is 0 or 1 rows
  const { data: stripeSub, error: stripeError } = await supabase
    .from('subscriptions')
    .select('status')
    .eq('user_id', user.id)
    .maybeSingle();

  if (stripeError) {
    // Matches the original webhook behaviour: a failed Stripe lookup doesn't block the downgrade
    console.warn(`[TierSync] Stripe lookup failed for ${email}, proceeding:`, stripeError.message);
  }
  if (stripeSub && (stripeSub.status === 'active' || stripeSub.status === 'trialing')) {
    console.log(`[TierSync] ${email} has active Stripe subscription - keeping premium (${reason})`);
    return { status: 'stripe_active_skip', userId: user.id };
  }

  if (dryRun) {
    return { status: 'would_downgrade', userId: user.id, previousTier: user.tier };
  }

  const { data: updated, error: downgradeError } = await supabase
    .from('users')
    .update({ tier: 'free' })
    .eq('id', user.id)
    .select('id');

  if (downgradeError) {
    console.error(`[TierSync] Error downgrading ${email}:`, downgradeError.message);
    return { status: 'error', userId: user.id, error: downgradeError.message };
  }
  if (!updated || updated.length === 0) {
    return { status: 'user_not_found' };
  }

  invalidateTierCaches(user.id);
  console.log(`[TierSync] ✅ ${email} downgraded to free (${reason}, was ${user.tier})`);
  return { status: 'downgraded', userId: user.id, previousTier: user.tier };
}

module.exports = {
  downgradeUserIfEligible,
  invalidateTierCaches,
};
