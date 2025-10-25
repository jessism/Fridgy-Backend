/**
 * Limit Enforcement Middleware
 * Checks usage limits before allowing operations for free tier users
 */

const usageService = require('../services/usageService');
const subscriptionService = require('../services/subscriptionService');

/**
 * Generic limit checker factory
 * @param {string} feature - Feature name to check (e.g., 'grocery_items', 'imported_recipes')
 * @returns {Function} Express middleware function
 */
function checkLimit(feature) {
  return async (req, res, next) => {
    try {
      console.log(`[checkLimits] MIDDLEWARE CALLED for feature: ${feature}`);
      const userId = req.user.id || req.user.userId;
      console.log(`[checkLimits] User ID: ${userId}`);

      if (!userId) {
        console.log(`[checkLimits] No user ID found - BLOCKING`);
        return res.status(401).json({
          error: 'UNAUTHORIZED',
          message: 'User not authenticated'
        });
      }

      // Check the limit
      console.log(`[checkLimits] Checking limit for user ${userId}, feature ${feature}`);
      const result = await usageService.checkLimit(userId, feature);
      console.log(`[checkLimits] Check result:`, result);

      if (!result.allowed) {
        return res.status(402).json({
          error: 'LIMIT_EXCEEDED',
          message: `You've reached your ${result.tier} tier limit for ${feature.replace(/_/g, ' ')}`,
          current: result.current,
          limit: result.limit,
          tier: result.tier,
          upgradeRequired: true,
          feature
        });
      }

      // Store check result in request for later use
      req.usageCheck = result;
      next();
    } catch (error) {
      console.error('[checkLimits] Error checking limit:', error);
      // FAIL CLOSED: Block request if we can't verify limits (security)
      // This prevents users from bypassing limits when database is down
      return res.status(503).json({
        error: 'SERVICE_UNAVAILABLE',
        message: 'Unable to verify usage limits. Please try again in a moment.',
        details: process.env.NODE_ENV === 'development' ? error.message : undefined
      });
    }
  };
}

/**
 * Specific limit checkers for each feature
 */

console.log('[checkLimits] MODULE LOADING - Creating middleware instances...');

// Inventory/grocery items limit (20 for free tier)
const checkInventoryLimit = checkLimit('grocery_items');
console.log('[checkLimits] checkInventoryLimit created:', typeof checkInventoryLimit);

// Imported recipes limit (10 for free tier)
const checkImportedRecipeLimit = checkLimit('imported_recipes');

// Uploaded/manual recipes limit (10 for free tier)
const checkUploadedRecipeLimit = checkLimit('uploaded_recipes');

// Meal logs limit (10 for free tier)
const checkMealLogLimit = checkLimit('meal_logs');

// Owned shopping lists limit (5 for free tier)
const checkShoppingListLimit = checkLimit('owned_shopping_lists');

// Joined shopping lists limit (1 for free tier)
const checkJoinedListLimit = checkLimit('joined_shopping_lists');

/**
 * Premium feature gate - requires premium or grandfathered tier
 * Used for features that are completely blocked on free tier (AI recipes, analytics)
 */
async function requirePremium(req, res, next) {
  try {
    const userId = req.user.id || req.user.userId;

    if (!userId) {
      return res.status(401).json({
        error: 'UNAUTHORIZED',
        message: 'User not authenticated'
      });
    }

    // Check user's subscription tier
    const subscription = await subscriptionService.getUserSubscription(userId);

    if (!subscription || subscription.tier === 'free') {
      return res.status(402).json({
        error: 'PREMIUM_REQUIRED',
        message: 'This feature requires a premium subscription',
        tier: 'free',
        upgradeRequired: true,
        premiumFeature: true
      });
    }

    // User is premium or grandfathered, allow access
    req.subscriptionTier = subscription.tier;
    next();
  } catch (error) {
    console.error('[requirePremium] Error checking premium status:', error);
    // On error, block access (fail closed for premium features)
    return res.status(500).json({
      error: 'SERVER_ERROR',
      message: 'Error verifying subscription status'
    });
  }
}

/**
 * Optional: Check limit but don't block (soft limit)
 * Returns usage info in response header but allows request to proceed
 * Useful for showing warnings to users
 */
function checkLimitSoft(feature) {
  return async (req, res, next) => {
    try {
      const userId = req.user.id || req.user.userId;

      if (userId) {
        const result = await usageService.checkLimit(userId, feature);

        // Add usage info to response headers
        res.setHeader('X-Usage-Current', result.current);
        res.setHeader('X-Usage-Limit', result.limit);
        res.setHeader('X-Usage-Tier', result.tier);
        res.setHeader('X-Usage-Allowed', result.allowed);

        // Store in request
        req.usageCheck = result;
      }

      next();
    } catch (error) {
      console.error('[checkLimitSoft] Error:', error);
      next();
    }
  };
}

/**
 * Increment usage counter after successful operation
 * Call this AFTER the operation succeeds (e.g., after database insert)
 */
async function incrementUsageCounter(userId, feature) {
  try {
    await usageService.incrementUsage(userId, feature);
  } catch (error) {
    console.error('[incrementUsageCounter] Error incrementing usage:', error);
    // Don't throw - usage tracking failure shouldn't break the operation
  }
}

/**
 * Decrement usage counter after deletion
 * Call this AFTER the delete operation succeeds
 */
async function decrementUsageCounter(userId, feature) {
  try {
    await usageService.decrementUsage(userId, feature);
  } catch (error) {
    console.error('[decrementUsageCounter] Error decrementing usage:', error);
  }
}

module.exports = {
  // Specific limit checkers
  checkInventoryLimit,
  checkImportedRecipeLimit,
  checkUploadedRecipeLimit,
  checkMealLogLimit,
  checkShoppingListLimit,
  checkJoinedListLimit,

  // Premium feature gate
  requirePremium,

  // Generic limit checker (for custom features)
  checkLimit,

  // Soft limit checker (non-blocking)
  checkLimitSoft,

  // Usage counter helpers
  incrementUsageCounter,
  decrementUsageCounter,
};
