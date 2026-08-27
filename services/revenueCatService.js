/**
 * RevenueCat Service
 * Handles Apple In-App Purchase subscriptions via RevenueCat
 */

const fetch = require('node-fetch');

// Trim whitespace/quotes — a stray newline or pasted quotes in the Railway
// env var makes the Authorization header invalid and RevenueCat returns 403.
const RAW_RC_KEY = process.env.REVENUECAT_SECRET_API_KEY || '';
const REVENUECAT_SECRET_KEY = RAW_RC_KEY.trim().replace(/^["']|["']$/g, '') || null;
const REVENUECAT_API_BASE = 'https://api.revenuecat.com/v1';

// Debug: Log if key is set (first 10 chars only for security)
if (REVENUECAT_SECRET_KEY) {
  console.log('[RevenueCat] API key loaded:', REVENUECAT_SECRET_KEY.substring(0, 10) + '...', `(len ${REVENUECAT_SECRET_KEY.length})`);
  if (REVENUECAT_SECRET_KEY !== RAW_RC_KEY) {
    console.warn(`[RevenueCat] ⚠️ Env var had surrounding whitespace/quotes (raw len ${RAW_RC_KEY.length}) — sanitized in code. Fix the Railway variable to silence this warning.`);
  }
} else {
  console.error('[RevenueCat] ⚠️ WARNING: REVENUECAT_SECRET_API_KEY not set!');
}

/**
 * Check if a user has an active premium subscription via RevenueCat
 * @param {string} userId - The user's email or ID (must match what mobile app uses)
 * @returns {Promise<Object|null>} Subscription info or null
 */
async function checkRevenueCatSubscription(userId) {
  if (!userId || !REVENUECAT_SECRET_KEY) {
    console.log('[RevenueCat] No user ID or API key configured');
    console.error(`[RevenueCat] DEBUG - userId: ${userId ? 'present' : 'missing'}, API key: ${REVENUECAT_SECRET_KEY ? REVENUECAT_SECRET_KEY.substring(0, 10) + '...' : 'MISSING!'}`);
    return null;
  }

  try {
    console.log(`[RevenueCat] Checking subscription for user: ${userId}`);
    console.log(`[RevenueCat] Using API key: ${REVENUECAT_SECRET_KEY.substring(0, 10)}...`);

    const url = `${REVENUECAT_API_BASE}/subscribers/${encodeURIComponent(userId)}`;

    const response = await fetch(url, {
      // NOTE: no X-Platform header. RevenueCat treats it as a client-app request and
      // rejects secret keys with 403 code 7243 ("Secret API keys should not be used
      // in your app"), which made this lookup return null for every user.
      headers: {
        'Authorization': `Bearer ${REVENUECAT_SECRET_KEY}`,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      if (response.status === 404) {
        // User not found in RevenueCat (never purchased)
        console.log(`[RevenueCat] User ${userId} not found in RevenueCat`);
        return null;
      }
      const errorBody = await response.text().catch(() => '');
      console.error(`[RevenueCat] API error: ${response.status}`);
      console.error(`[RevenueCat] Request URL: ${url}`);
      console.error(`[RevenueCat] Response body: ${errorBody.slice(0, 300)}`);
      console.error(`[RevenueCat] Auth header: Bearer ${REVENUECAT_SECRET_KEY.substring(0, 15)}... (len ${REVENUECAT_SECRET_KEY.length})`);
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

/**
 * Raw subscriber fetch. One place for the HTTP call so callers can tell an API
 * failure apart from "no subscription".
 * @returns {Promise<{ok: boolean, httpStatus: number, subscriber?: Object, error?: string}>}
 */
async function fetchSubscriberRaw(appUserId) {
  if (!REVENUECAT_SECRET_KEY) {
    return { ok: false, httpStatus: 0, error: 'not_configured' };
  }
  try {
    const response = await fetch(`${REVENUECAT_API_BASE}/subscribers/${encodeURIComponent(appUserId)}`, {
      headers: {
        'Authorization': `Bearer ${REVENUECAT_SECRET_KEY}`,
        'Content-Type': 'application/json',
      },
      timeout: 10000,
    });
    if (response.status === 404) {
      return { ok: false, httpStatus: 404 };
    }
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      return { ok: false, httpStatus: response.status, error: body.slice(0, 300) };
    }
    // 200, or 201 when RevenueCat creates a subscriber it has never seen
    const data = await response.json();
    return { ok: true, httpStatus: response.status, subscriber: data.subscriber || {} };
  } catch (error) {
    return { ok: false, httpStatus: 0, error: error.message };
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function isTransientFailure(raw) {
  if (raw.error === 'not_configured') return false;
  return raw.httpStatus === 0 || raw.httpStatus === 429 || raw.httpStatus >= 500;
}

/**
 * Entitlement state that distinguishes "expired" from "the API call failed".
 * Unlike checkRevenueCatSubscription this never collapses errors to null — a sweep
 * that downgrades users must not act on an outage.
 *
 * @param {string} appUserId - email (matches the mobile app's app_user_id)
 * @param {Object} [options]
 * @param {string} [options.entitlementId='premium']
 * @param {number} [options.retries=1] - retries for transient failures (429/5xx/network)
 * @returns {Promise<{state: 'active'|'expired'|'none'|'error', httpStatus: number, expiresAt?: string, graceExpiresAt?: string, isSandbox?: boolean, productId?: string, billingIssue?: boolean, error?: string}>}
 */
async function getEntitlementState(appUserId, { entitlementId = 'premium', retries = 1 } = {}) {
  let raw = await fetchSubscriberRaw(appUserId);
  for (let attempt = 0; attempt < retries && !raw.ok && isTransientFailure(raw); attempt++) {
    await sleep(2000);
    raw = await fetchSubscriberRaw(appUserId);
  }

  if (raw.httpStatus === 404) return { state: 'none', httpStatus: 404 };
  if (!raw.ok) return { state: 'error', httpStatus: raw.httpStatus, error: raw.error };

  const subscriber = raw.subscriber;
  const now = Date.now();
  const parse = (d) => (d ? Date.parse(d) : null);
  const entitlement = subscriber.entitlements?.[entitlementId];

  if (!entitlement) {
    // Defensive: a live store subscription with no entitlement mapping still counts as paid
    const liveSub = Object.values(subscriber.subscriptions || {}).find((sub) => {
      const expires = parse(sub.expires_date);
      const grace = parse(sub.grace_period_expires_date);
      return expires === null || expires > now || (grace !== null && grace > now);
    });
    if (liveSub) {
      return {
        state: 'active',
        httpStatus: raw.httpStatus,
        expiresAt: liveSub.expires_date,
        isSandbox: !!liveSub.is_sandbox,
        note: 'subscription_without_entitlement',
      };
    }
    return { state: 'none', httpStatus: raw.httpStatus };
  }

  const productId = entitlement.product_identifier;
  const sub = subscriber.subscriptions?.[productId] || {};
  const expires = parse(entitlement.expires_date);
  const grace = Math.max(
    parse(entitlement.grace_period_expires_date) || 0,
    parse(sub.grace_period_expires_date) || 0
  ) || null;
  // null expires_date = non-expiring entitlement
  const effective = expires === null ? Infinity : Math.max(expires, grace || 0);

  return {
    state: effective > now ? 'active' : 'expired',
    httpStatus: raw.httpStatus,
    expiresAt: entitlement.expires_date,
    graceExpiresAt: grace ? new Date(grace).toISOString() : undefined,
    isSandbox: !!sub.is_sandbox,
    productId,
    billingIssue: !!sub.billing_issues_detected_at,
  };
}

module.exports = {
  checkRevenueCatSubscription,
  getSubscriberInfo,
  hasActiveEntitlement,
  getEntitlementState,
};
