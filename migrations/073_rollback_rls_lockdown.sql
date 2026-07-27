-- ============================================================================
-- ROLLBACK for 073_enable_rls_lockdown.sql
-- Restores anon/authenticated access (the INSECURE pre-lockdown state).
-- Use only if the app breaks and the cause is confirmed to be 073.
-- The dropped policies are NOT recreated — with full grants restored and RLS
-- disabled they are not needed for the app to function.
-- ============================================================================

-- Undo STEP 3 (default privileges)
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon, authenticated;

-- Undo STEP 2 (grants)
GRANT ALL ON ALL TABLES IN SCHEMA public TO anon, authenticated;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO anon, authenticated;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO PUBLIC;

-- Undo STEP 1 (disable RLS everywhere except tables that had it before 073:
-- users, fridge_items, onboarding_sessions, apify_usage, tiktok_cache,
-- saved_recipes, shortcut_tokens, recipe_collections, recipe_collection_items
-- — leaving RLS on for those is safe once grants are restored ONLY where a
-- permissive policy existed; to fully restore pre-073 behavior for users and
-- fridge_items, the permissive policies are recreated below.)
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT c.relname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relrowsecurity
      AND c.relname NOT IN ('users', 'fridge_items', 'onboarding_sessions',
                            'apify_usage', 'tiktok_cache', 'saved_recipes',
                            'shortcut_tokens', 'recipe_collections',
                            'recipe_collection_items')
  LOOP
    EXECUTE format('ALTER TABLE public.%I DISABLE ROW LEVEL SECURITY', r.relname);
  END LOOP;
END $$;

-- Recreate the pre-073 permissive policies on users / fridge_items
CREATE POLICY "Allow anon select by email" ON public.users
  FOR SELECT TO anon USING (true);
CREATE POLICY "Allow anon insert" ON public.users
  FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "Allow all operations for now" ON public.fridge_items
  FOR ALL TO anon, authenticated USING (true);
