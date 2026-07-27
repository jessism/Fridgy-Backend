-- ============================================================================
-- 073: RLS lockdown — close the leaked-anon-key hole
-- Plan: trackabite-mobile/MD_files/SECURITY_SUPABASE_RLS.md (Phase 2)
--
-- PREREQUISITE (already deployed + verified): backend commit 1dfd6e8 routes
-- 100% of DB traffic through the service_role client. service_role has
-- BYPASSRLS, so nothing below affects the app.
--
-- HOW TO RUN: paste ONE STEP at a time into the Supabase SQL editor.
-- After each step, use the app for a minute (login, inventory, meals,
-- shopping list) before running the next step.
-- Rollback: 073_rollback_rls_lockdown.sql
-- ============================================================================


-- ============================================================================
-- STEP 1 — Enable RLS on every table in schema public that lacks it.
-- With no policies, this is default-deny for anon/authenticated.
-- service_role bypasses RLS, so the app is unaffected.
-- ============================================================================
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT c.relname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind = 'r'          -- ordinary tables only (not views)
      AND NOT c.relrowsecurity
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', r.relname);
    RAISE NOTICE 'RLS enabled on %', r.relname;
  END LOOP;
END $$;

-- Verify step 1: must return 0 rows
SELECT c.relname AS table_still_without_rls
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind = 'r' AND NOT c.relrowsecurity;

-- >>> Now check the app works, then continue with STEP 2. <<<


-- ============================================================================
-- STEP 2 — Revoke anon/authenticated access and drop the permissive/dead
-- policies. This is the step that actually neutralizes the leaked key.
-- ============================================================================

-- 2a. Table + sequence grants (includes views, which also closes the anon
--     grants on ingredient_images_view / v_user_usage_summary)
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon, authenticated;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon, authenticated;

-- 2b. Functions: EXECUTE defaults to PUBLIC, and SECURITY DEFINER functions
--     (record_streak_action, increment_usage_counter, increment_apify_usage,
--     increment_order_indices*) are write paths the leaked key could still
--     call. All legitimate callers are service_role since Phase 1.
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO service_role;

-- 2c. Drop every policy that isn't a service_role policy. This removes:
--     users:        "Allow anon select by email", "Allow anon insert"
--     fridge_items: "Allow all operations for now"
--     plus all dead auth.uid() policies (auth.uid() is always NULL with our
--     custom JWT — they can never match, they're just clutter).
--     service_role policies (e.g. on onboarding_sessions) are kept.
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT schemaname, tablename, policyname
    FROM pg_policies
    WHERE schemaname = 'public'
      AND NOT ('service_role' = ANY(roles))
  LOOP
    EXECUTE format('DROP POLICY %I ON %I.%I', r.policyname, r.schemaname, r.tablename);
    RAISE NOTICE 'Dropped policy % on %', r.policyname, r.tablename;
  END LOOP;
END $$;

-- Verify step 2: both must return 0 rows
SELECT grantee, table_name, privilege_type
FROM information_schema.role_table_grants
WHERE table_schema = 'public' AND grantee IN ('anon', 'authenticated');

SELECT tablename, policyname
FROM pg_policies
WHERE schemaname = 'public' AND NOT ('service_role' = ANY(roles));

-- >>> Now check the app again (login, inventory, meals, shopping list,
--     cookbook, a public share link in incognito), then run STEP 3. <<<


-- ============================================================================
-- STEP 3 — Durability: stop future migrations from silently re-opening the
-- hole. New tables created by the postgres role will no longer auto-grant
-- to anon/authenticated. (New tables still start with RLS off — enable RLS
-- in every future CREATE TABLE migration.)
-- ============================================================================
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM anon, authenticated;

-- Verify step 3: no acl entries for anon/authenticated
SELECT pg_get_userbyid(defaclrole) AS grantor, defaclobjtype, defaclacl
FROM pg_default_acl d
JOIN pg_namespace n ON n.oid = d.defaclnamespace
WHERE n.nspname = 'public';
