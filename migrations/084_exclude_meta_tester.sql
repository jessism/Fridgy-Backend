-- Migration 084: exclude the Meta app-review tester from every report
--
-- Why: vancitypcrepairs@gmail.com ("Trackabite Meta App Tester") is an internal
-- account created so Meta could review the app. It was granted premium by hand,
-- so it counted as a real user everywhere AND as a paying subscriber: it is the
-- account PLAN_ANALYTICS_AUG29.md flagged as "1 premium account with no Stripe
-- row and no RevenueCat production event".
--
-- Nothing about the address says "test", so neither the 080 backfill nor the
-- 081 trigger caught it. This flags it and adds it to the trigger's list, which
-- must stay in step with services/internalAccounts.js.
--
-- Apply in the Supabase SQL editor (safe to re-run).

-- 1. Flag the account.
UPDATE public.users
SET is_test = true
WHERE is_test IS NOT TRUE
  AND LOWER(email) = 'vancitypcrepairs@gmail.com';

-- 2. Same list, in the trigger. Body copied from migration 081 with the one
--    address added; the trigger itself is unchanged, so it is not re-created.
CREATE OR REPLACE FUNCTION public.mark_internal_account()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.is_test IS NOT TRUE AND NEW.email IS NOT NULL AND (
       LOWER(NEW.email) LIKE '%test%'
       OR LOWER(NEW.email) IN (
            'hello@trackabite.app',
            'jessie@trackabite.app',
            'trangmh.sac.ftu@gmail.com',
            'system@trackabite.app',
            'adityabiswas1999@hotmail.com',
            'adityabiswas1999@hotmail.coma',
            'abiswas@sfu.ca',
            'hello@trackabte.app',
            'jessietrackie@gmail.com',
            'tann.kh0ngtuoc@gmail.com',
            'nathannorth2005@gmail.com',
            'vancitypcrepairs@gmail.com'
          )
       OR SPLIT_PART(LOWER(NEW.email), '@', 2) IN
            ('example.com', 'example.org', 'example.net', 'test.com', 'trackabte.app')
     )
  THEN
    NEW.is_test := true;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION public.mark_internal_account() IS
  'Sets users.is_test for internal/QA addresses. Mirrors services/internalAccounts.js — change both together.';

-- Expected after running, as of 2026-09-02: 118 flagged, 14 real users (was 15).
--   SELECT COUNT(*) FILTER (WHERE is_test)                        AS flagged,
--          COUNT(*) FILTER (WHERE NOT is_test AND NOT is_admin
--                           AND id <> '00000000-0000-0000-0000-000000000001') AS real_users
--   FROM public.users;
