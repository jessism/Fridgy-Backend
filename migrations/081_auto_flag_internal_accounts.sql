-- Migration 081: keep users.is_test correct by itself
--
-- Migration 080 added the column and backfilled it once. Two gaps remained:
--
--   1. It was a one-off. A new account signing up as `foo+test@gmail.com` was
--      kept out of the admin console by a read-time email check, but its
--      is_test stayed false — so nothing else in the system knew, and its
--      PostHog events kept flowing.
--   2. trangmh.sac.ftu@gmail.com and system@trackabite.app were excluded only
--      incidentally: one because it is an admin, one by a hardcoded UUID.
--      Revoke that admin flag and the account silently rejoins every number.
--
-- This migration flags those two explicitly and adds a trigger so the column
-- maintains itself from here on.
--
-- Apply in the Supabase SQL editor (safe to re-run).

-- 1. The two accounts that must never appear in a report again.
UPDATE public.users
SET is_test = true
WHERE is_test IS NOT TRUE
  AND (
    LOWER(email) IN ('trangmh.sac.ftu@gmail.com', 'system@trackabite.app')
    OR id = '00000000-0000-0000-0000-000000000001'
  );

-- 2. Auto-flag internal accounts on the way in.
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
            'nathannorth2005@gmail.com'
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

-- BEFORE INSERT OR UPDATE **OF email**, deliberately: firing only when the
-- address changes means a manual `UPDATE users SET is_test = false` sticks.
-- That is the escape hatch if a real customer ever has "test" in their address.
DROP TRIGGER IF EXISTS users_mark_internal ON public.users;
CREATE TRIGGER users_mark_internal
  BEFORE INSERT OR UPDATE OF email ON public.users
  FOR EACH ROW
  EXECUTE FUNCTION public.mark_internal_account();

-- Expected after running, as of 2026-08-30: 117 flagged, 15 real users.
-- (080 left 115; this adds trangmh + the system user.)
--   SELECT COUNT(*) FILTER (WHERE is_test)                        AS flagged,
--          COUNT(*) FILTER (WHERE NOT is_test AND NOT is_admin
--                           AND id <> '00000000-0000-0000-0000-000000000001') AS real_users
--   FROM public.users;
