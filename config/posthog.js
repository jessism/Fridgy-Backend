/**
 * PostHog Analytics Configuration (Backend)
 * Used for server-side event tracking (e.g., webhook events, subscription changes)
 */

const { PostHog } = require('posthog-node');

let posthogClient = null;

/**
 * Get or initialize the PostHog client
 * @returns {PostHog|null} PostHog client instance or null if not configured
 */
function getPostHogClient() {
  // Return existing client if already initialized
  if (posthogClient) {
    return posthogClient;
  }

  // Check if PostHog is configured
  const apiKey = process.env.POSTHOG_API_KEY;
  const host = process.env.POSTHOG_HOST || 'https://us.i.posthog.com';

  if (!apiKey) {
    console.warn('[PostHog] API key not configured - analytics disabled');
    return null;
  }

  try {
    // Initialize PostHog client
    posthogClient = new PostHog(apiKey, {
      host: host,
      flushAt: 1, // Send events immediately (important for webhooks)
      flushInterval: 0, // Don't batch events
    });

    console.log('[PostHog] Client initialized successfully');
    return posthogClient;
  } catch (error) {
    console.error('[PostHog] Failed to initialize client:', error);
    return null;
  }
}

/**
 * Track an event in PostHog
 * @param {string} distinctId - User ID or identifier
 * @param {string} event - Event name
 * @param {Object} properties - Event properties
 */
async function trackEvent(distinctId, event, properties = {}) {
  const client = getPostHogClient();

  if (!client) {
    console.log('[PostHog] Skipping event (client not configured):', event);
    return;
  }

  try {
    client.capture({
      distinctId,
      event,
      properties: {
        ...properties,
        source: 'backend',
        timestamp: new Date().toISOString(),
      },
    });

    // Ensure event is sent before function returns
    await client.flush();

    console.log(`[PostHog] Event tracked: ${event} for user: ${distinctId}`);
  } catch (error) {
    console.error('[PostHog] Error tracking event:', error);
  }
}

/**
 * Identify a user with properties
 * @param {string} distinctId - User ID
 * @param {Object} properties - User properties
 */
async function identifyUser(distinctId, properties = {}) {
  const client = getPostHogClient();

  if (!client) {
    console.log('[PostHog] Skipping identify (client not configured)');
    return;
  }

  try {
    client.identify({
      distinctId,
      properties,
    });

    await client.flush();

    console.log(`[PostHog] User identified: ${distinctId}`);
  } catch (error) {
    console.error('[PostHog] Error identifying user:', error);
  }
}

/**
 * Shutdown PostHog client (call on server shutdown)
 */
async function shutdown() {
  if (posthogClient) {
    await posthogClient.shutdown();
    console.log('[PostHog] Client shut down');
  }
}

module.exports = {
  getPostHogClient,
  trackEvent,
  identifyUser,
  shutdown,
};
