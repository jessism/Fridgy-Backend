/**
 * Feature-usage tracking.
 *
 * Registered globally (before the routers). Route-level `authenticateToken`
 * sets req.user before the handler runs, so by the time the response
 * finishes we know who did what. Emits a PostHog `feature_used` event and
 * bumps users.last_active_at (throttled). Fire-and-forget: never blocks or
 * fails the request.
 */
const { getPostHogClient } = require('../config/posthog');
const { getServiceClient } = require('../config/supabase');
const { resolveFeature, resolvePlatform } = require('../services/featureEventMap');
const { isInternalAccount } = require('../services/internalAccounts');

const LAST_ACTIVE_THROTTLE_MS = 5 * 60 * 1000;
const LAST_ACTIVE_REARM_MS = 10 * 60 * 1000;
const lastActiveWrites = new Map(); // userId -> epoch ms of last write
// Paused only when Postgres says the column really doesn't exist (42703),
// and only for LAST_ACTIVE_REARM_MS. A message-regex latch used to disable
// this for the process lifetime — and PostgREST's transient schema-cache miss
// right after a migration produces exactly that message.
let lastActivePausedUntil = 0;

function touchLastActive(userId) {
  const now = Date.now();
  if (now < lastActivePausedUntil) return;
  const prev = lastActiveWrites.get(userId) || 0;
  if (now - prev < LAST_ACTIVE_THROTTLE_MS) return;
  lastActiveWrites.set(userId, now);

  // Bound the map so a long-running process doesn't grow forever.
  if (lastActiveWrites.size > 10000) {
    for (const [id, ts] of lastActiveWrites) {
      if (now - ts > LAST_ACTIVE_THROTTLE_MS) lastActiveWrites.delete(id);
    }
  }

  getServiceClient()
    .from('users')
    .update({ last_active_at: new Date(now).toISOString() })
    .eq('id', userId)
    .then(({ error }) => {
      if (!error) return;
      if (error.code === '42703') {
        lastActivePausedUntil = Date.now() + LAST_ACTIVE_REARM_MS;
        console.warn('[FeatureTracking] users.last_active_at missing — apply migrations/078_add_last_active_at.sql (retrying in 10 min)');
        return;
      }
      console.warn('[FeatureTracking] last_active_at update failed:', error.message);
    });
}

function featureTracking(req, res, next) {
  res.on('finish', () => {
    try {
      const user = req.user;
      if (!user || !user.id) return;                 // unauthenticated / failed auth
      if (res.statusCode >= 400) return;             // only count things that worked
      // Express reports router.get('/') as baseUrl + '/' — normalise the
      // trailing slash so the map's patterns (e.g. /api/inventory) match.
      const rawPath = req.route ? `${req.baseUrl || ''}${req.route.path}` : null;
      const routePath = rawPath && rawPath.length > 1 ? rawPath.replace(/\/$/, '') : rawPath;
      const resolved = resolveFeature(req.method, routePath);

      // last_active_at is still written for internal accounts: only the admin
      // analytics service reads it, and that filters them out anyway, so it
      // stays useful when looking one up on the user detail page.
      touchLastActive(user.id);
      if (!resolved) return;

      // Admins, the system user and test accounts must not reach PostHog, or
      // its dashboards disagree with the admin console. Set
      // FEATURE_TRACKING_INCLUDE_INTERNAL=1 to watch your own events land.
      if (!process.env.FEATURE_TRACKING_INCLUDE_INTERNAL && isInternalAccount(user)) {
        if (process.env.FEATURE_TRACKING_DEBUG) console.log(`[FeatureTracking] skipped internal account ${user.email}`);
        return;
      }

      const client = getPostHogClient();
      if (!client) return;
      if (process.env.FEATURE_TRACKING_DEBUG) console.log(`[FeatureTracking] ${user.id} ${resolved.feature}/${resolved.action} (${routePath})`);
      client.capture({
        distinctId: user.id,
        event: 'feature_used',
        properties: {
          feature: resolved.feature,
          action: resolved.action,
          platform: resolvePlatform(req),
          route: routePath,
          method: req.method,
          source: 'backend',
        },
      });
    } catch (err) {
      console.warn('[FeatureTracking] skipped:', err.message);
    }
  });
  next();
}

module.exports = { featureTracking };
