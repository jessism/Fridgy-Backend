-- Migration 078: users.last_active_at
-- Purpose: cheap "last seen" for the admin analytics page. Written by
--   middleware/featureTracking.js (throttled to once per 5 min per user).
--   PostHog owns DAU/WAU/MAU; this is only for per-user lookup and sorting.
-- Date: 2026-08-29

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS last_active_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_users_last_active_at
  ON public.users (last_active_at DESC NULLS LAST);

COMMENT ON COLUMN public.users.last_active_at IS
  'Last successful authenticated API call (throttled, ~5 min resolution). Set by middleware/featureTracking.js.';
