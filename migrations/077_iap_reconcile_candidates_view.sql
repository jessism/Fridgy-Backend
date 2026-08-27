-- Migration: IAP reconcile candidates view
-- Purpose: Premium users whose entitlement is NOT backed by Stripe or a grandfather
--          flag, with the newest RevenueCat expiry we have on file. Read nightly by
--          services/iapReconcileScheduler.js, which confirms each row against the
--          live RevenueCat API before downgrading anyone.
-- Date: August 26, 2026
--
-- Ordering by the LARGEST expiration_at_ms (not the newest created_at) means a late
-- RENEWAL delivery can't be shadowed by an older CANCELLATION. TRANSFER events carry
-- no expiration_at_ms and drop out. Matching on aliases / original_app_user_id picks
-- up events that arrived under an anonymous id before the user signed up.
-- Service-role only: migration 073's default privileges apply, REVOKE is belt and braces.

CREATE OR REPLACE VIEW public.iap_reconcile_candidates AS
SELECT
  u.id            AS user_id,
  u.email,
  u.tier,
  u.created_at    AS user_created_at,
  exp.event_type  AS latest_expiry_event_type,
  exp.created_at  AS latest_expiry_event_at,
  exp.environment AS latest_expiry_environment,
  exp.expires_at  AS latest_expiration_at,   -- NULL => no stored event carries expiration_at_ms
  (
    SELECT COUNT(*)
    FROM revenuecat_webhook_events e
    WHERE e.app_user_id = u.email
       OR e.payload->'event'->'aliases' ? u.email
       OR e.payload->'event'->>'original_app_user_id' = u.email
  ) AS event_count
FROM users u
LEFT JOIN LATERAL (
  SELECT
    e.event_type,
    e.created_at,
    e.payload->'event'->>'environment' AS environment,
    to_timestamp((e.payload->'event'->>'expiration_at_ms')::bigint / 1000.0) AS expires_at
  FROM revenuecat_webhook_events e
  WHERE (
          e.app_user_id = u.email
       OR e.payload->'event'->'aliases' ? u.email
       OR e.payload->'event'->>'original_app_user_id' = u.email
        )
    AND e.payload->'event'->>'expiration_at_ms' IS NOT NULL
  ORDER BY (e.payload->'event'->>'expiration_at_ms')::bigint DESC, e.created_at DESC
  LIMIT 1
) exp ON true
WHERE u.tier IN ('premium', 'grandfathered')
  AND COALESCE(u.is_grandfathered, false) = false
  AND NOT EXISTS (
    SELECT 1 FROM subscriptions s
    WHERE s.user_id = u.id
      AND s.status IN ('active', 'trialing')
  );

REVOKE ALL ON public.iap_reconcile_candidates FROM anon, authenticated;

-- Verify
SELECT email, tier, latest_expiry_event_type, latest_expiration_at, event_count
FROM public.iap_reconcile_candidates
ORDER BY latest_expiration_at NULLS FIRST;
