-- Migration 090: public share links for saved recipes.
--
-- A user taps Share on a recipe they own; the backend mints a slug
-- ("miso-butter-salmon-k7m2xq9p4rvn") and the recipe becomes readable at
-- https://www.trackabite.app/r/<slug> with no account. The existing
-- `visibility` column (062) is the on/off bit: 'public' = link live,
-- 'private' = link returns 410. The slug is kept on unshare so re-sharing
-- yields the same URL.
--
-- Additive only, safe to re-run. Creates no table, so RLS on saved_recipes
-- (locked down in 073, anon has zero grants) is untouched.
--
-- Apply in the Supabase SQL editor BEFORE deploying the backend that writes
-- these columns. Apply as a WHOLE file (scripts/runMigration.js splits on
-- semicolons and would break the DO block).

-- Pre-flight (expect 0): nothing has ever written visibility='public'.
-- SELECT count(*) FROM public.saved_recipes WHERE visibility = 'public';

ALTER TABLE public.saved_recipes
  ADD COLUMN IF NOT EXISTS share_slug TEXT,
  ADD COLUMN IF NOT EXISTS shared_at TIMESTAMPTZ;

COMMENT ON COLUMN public.saved_recipes.share_slug IS
  'Public URL id for /r/<slug>: title slug + 14-char random token. Kept after unshare so the link is stable.';
COMMENT ON COLUMN public.saved_recipes.shared_at IS
  'When sharing was last turned on (NULL while private).';

-- Exact-match lookup for the public route; partial so private rows cost nothing.
CREATE UNIQUE INDEX IF NOT EXISTS idx_saved_recipes_share_slug
  ON public.saved_recipes (share_slug)
  WHERE share_slug IS NOT NULL;

-- A public row with no slug would be exposed-but-unreachable. NOT VALID so
-- the ALTER never scans existing rows; new writes are checked.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_saved_recipes_public_has_slug'
      AND conrelid = 'public.saved_recipes'::regclass
  ) THEN
    ALTER TABLE public.saved_recipes
      ADD CONSTRAINT chk_saved_recipes_public_has_slug
      CHECK (visibility <> 'public' OR share_slug IS NOT NULL) NOT VALID;
  END IF;
END $$;

-- Post-apply verification (run by hand):
-- 1. Columns exist:
--    SELECT column_name FROM information_schema.columns
--    WHERE table_name = 'saved_recipes' AND column_name IN ('share_slug','shared_at');
-- 2. Index exists:
--    SELECT indexname FROM pg_indexes WHERE indexname = 'idx_saved_recipes_share_slug';
-- 3. RLS still on:
--    SELECT relrowsecurity FROM pg_class WHERE oid = 'public.saved_recipes'::regclass;  -- true
-- 4. anon still has nothing:
--    SELECT count(*) FROM information_schema.role_table_grants
--    WHERE grantee = 'anon' AND table_schema = 'public';  -- 0
