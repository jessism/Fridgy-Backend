-- Migration 080: users.is_test — flag internal/test accounts without a deploy
--
-- Why: the admin analytics "real user" filter relied on the email containing
-- the word "test", plus a hardcoded list in services/adminAnalyticsService.js.
-- That list needed a code deploy to change, and it missed accounts that simply
-- don't say "test" — a typo'd variant of an owned address, a personal address,
-- an App Store sandbox tester. Seven such accounts were counting as real users
-- (22 -> 15 once excluded), which diluted every adoption percentage.
--
-- After this is applied, flag an account by setting is_test = true. The service
-- prefers this column and keeps the email heuristics as a backstop, so nothing
-- breaks whether or not it has been run.
--
-- Apply in the Supabase SQL editor (safe to re-run).

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS is_test BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN public.users.is_test IS
  'Internal/test account: excluded from admin analytics. Set true for QA accounts, sandbox IAP testers and the team''s own logins.';

-- Partial index: the flagged set is small and is filtered on every load.
CREATE INDEX IF NOT EXISTS idx_users_is_test ON public.users(is_test) WHERE is_test = true;

-- Backfill everything the heuristics currently exclude, so the column becomes
-- the source of truth going forward.
UPDATE public.users SET is_test = true
WHERE is_test = false
  AND (
    LOWER(email) LIKE '%test%'
    OR LOWER(email) IN (
      'hello@trackabite.app',
      'jessie@trackabite.app',
      'adityabiswas1999@hotmail.com',
      'adityabiswas1999@hotmail.coma',  -- typo variant, first_name "Aditya", no activity
      'abiswas@sfu.ca',                 -- owner's personal address
      'hello@trackabte.app',            -- typo of the trackabite.app domain
      'jessietrackie@gmail.com',        -- first_name "Trackie"
      'tann.kh0ngtuoc@gmail.com',       -- first_name "Jessie"
      'nathannorth2005@gmail.com'       -- six daily SANDBOX App Store renewals
    )
    OR SPLIT_PART(LOWER(email), '@', 2) IN ('example.com', 'example.org', 'example.net', 'test.com', 'trackabte.app')
  );

-- Deliberately NOT flagged: admins (excluded by is_admin, and revoking that
-- flag should put the person back in the numbers) and the system user
-- (excluded by id).

-- Expected after running, as of 2026-08-30: 117 flagged, 15 real users.
--   SELECT COUNT(*) FILTER (WHERE is_test) AS flagged,
--          COUNT(*) FILTER (WHERE NOT is_test AND NOT is_admin) AS remaining
--   FROM public.users;
