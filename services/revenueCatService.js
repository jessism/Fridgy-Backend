/**
 * RevenueCat Service
 * Handles Apple In-App Purchase subscriptions via RevenueCat
 */

const fetch = require('node-fetch');

const REVENUECAT_SECRET_KEY = process.env.REVENUECAT_SECRET_API_KEY;
const REVENUECAT_API_BASE = 'https://api.revenuecat.com/v1';

/**
 * Check if a user has an active premium subscription via RevenueCat
 * @param {string} userId - The user's email or ID (must match what mobile app uses)
 * @returns {Promise<Object|null>} Subscription info or null
 */
async function checkRevenueCatSubscription(userId) {
  if (!userId || !REVENUECAT_SECRET_KEY) {
    console.log('[RevenueCat] No user ID or API key configured');
    return null;
  }

  try {
    const url = `${REVENUECAT_API_BASE}/subscribers/${encodeURIComponent(userId)}`;

    const response = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${REVENUECAT_SECRET_KEY}`,
        'Content-Type': 'application/json',
        'X-Platform': 'ios',
      },
    });

    if (!response.ok) {
      if (response.status === 404) {
        // User not found in RevenueCat (never purchased)
        console.log(`[RevenueCat] User ${userId} not found in RevenueCat`);
        return null;
      }
      console.error(`[RevenueCat] API error: ${response.status}`);
      return null;
    }

    const data = await response.json();
    const subscriber = data.subscriber;

    // Check if user has the 'premium' entitlement active
    const premiumEntitlement = subscriber?.entitlements?.premium;

    if (premiumEntitlement && premiumEntitlement.expires_date) {
      const expiresAt = new Date(premiumEntitlement.expires_date);
      const isActive = expiresAt > new Date();

      if (isActive) {
        const productId = premiumEntitlement.product_identifier;
        const subscription = subscriber.subscriptions?.[productId];

        console.log(`[RevenueCat] ✅ Active premium subscription found for ${userId}`);

        return {
          active: true,
          source: subscription?.is_sandbox ? 'test_store' : 'apple',
          expiresAt: premiumEntitlement.expires_date,
          productId: productId,
          willRenew: !subscriber.unsubscribe_detected_at,
          isSandbox: subscription?.is_sandbox || false,
          purchaseDate: premiumEntitlement.purchase_date,
          periodType: subscription?.period_type || 'normal',
        };
      } else {
        console.log(`[RevenueCat] Premium subscription expired for ${userId}`);
      }
    } else {
      console.log(`[RevenueCat] No premium entitlement found for ${userId}`);
    }

    return null;
  } catch (error) {
    console.error('[RevenueCat] Error checking subscription:', error.message);
    return null;
  }
}

/**
 * Get detailed subscriber info from RevenueCat
 * @param {string} userId - The user's email or ID
 * @returns {Promise<Object|null>} Full subscriber data or null
 */
async function getSubscriberInfo(userId) {
  if (!userId || !REVENUECAT_SECRET_KEY) {
    return null;
  }

  try {
    const url = `${REVENUECAT_API_BASE}/subscribers/${encodeURIComponent(userId)}`;

    const response = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${REVENUECAT_SECRET_KEY}`,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      return null;
    }

    const data = await response.json();
    return data.subscriber;
  } catch (error) {
    console.error('[RevenueCat] Error getting subscriber info:', error.message);
    return null;
  }
}

/**
 * Check if user has any active entitlement
 * @param {string} userId - The user's email or ID
 * @param {string} entitlementId - The entitlement to check (default: 'premium')
 * @returns {Promise<boolean>} True if user has active entitlement
 */
async function hasActiveEntitlement(userId, entitlementId = 'premium') {
  const subscription = await checkRevenueCatSubscription(userId);
  return subscription?.active || false;
}

module.exports = {
  checkRevenueCatSubscription,
  getSubscriberInfo,
  hasActiveEntitlement,
};
