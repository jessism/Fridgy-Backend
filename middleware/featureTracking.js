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

const LAST_ACTIVE_THROTTLE_MS = 5 * 60 * 1000;
const lastActiveWrites = new Map(); // userId -> epoch ms of last write
let lastActiveEnabled = true;       // flipped off if migration 078 is not applied

function touchLastActive(userId) {
  if (!lastActiveEnabled) return;
  const now = Date.now();
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
      if (/last_active_at/.test(error.message)) {
        lastActiveEnabled = false;
        console.warn('[FeatureTracking] users.last_active_at missing — apply migrations/078_add_last_active_at.sql (disabled until restart)');
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

      touchLastActive(user.id);
      if (!resolved) return;

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
