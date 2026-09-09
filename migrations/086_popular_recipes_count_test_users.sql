-- Migration 086: popular_saved_recipes() — count test/internal accounts too
--
-- 085 excluded rows owned by users.is_test accounts and the system user from
-- the Home "Popular Now" ranking. With only a handful of real users that left
-- the shelf too thin to be interesting, and the team's own saves are real
-- signal for now. This re-issues the function with the same signature and the
-- same body, minus the users JOIN and the two owner-based filters.
--
-- What is deliberately KEPT: the import_method = 'default_seed' exclusion.
-- That is not a test-user rule — "Rosemary Gnocchi" was seeded into every older
-- account and nobody chose it; counting it would put it at #1.
--
-- Same signature, so this is a plain CREATE OR REPLACE: no overload, PostgREST
-- keeps resolving .rpc('popular_saved_recipes'), and ownership + grants carry
-- over. The REVOKE/GRANT lines are repeated anyway — idempotent insurance.
--
-- To REVERT (exclude test accounts again): re-run 085 in full.
--
-- Apply in the Supabase SQL editor (safe to re-run).

CREATE OR REPLACE FUNCTION public.popular_saved_recipes(limit_n integer DEFAULT 12)
RETURNS TABLE (
  id                    uuid,
  title                 text,
  summary               text,
  image                 text,
  "extendedIngredients" jsonb,
  "readyInMinutes"      integer,
  servings              integer,
  source_author         text,
  source_type           text,
  source_url            text,
  cuisines              text[],
  "dishTypes"           text[],
  vegetarian            boolean,
  vegan                 boolean,
  "glutenFree"          boolean,
  "dairyFree"           boolean,
  created_at            timestamptz,
  saver_count           bigint
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
WITH eligible AS (
  SELECT
    r.id, r.user_id, r.title, r.summary, r.image,
    r."extendedIngredients", r."readyInMinutes", r.servings,
    r.source_author, r.source_type, r.source_url,
    r.cuisines, r."dishTypes",
    r.vegetarian, r.vegan, r."glutenFree", r."dairyFree",
    r.created_at,
    -- Same key as recipeController.js dedupeKey(); keep the two in step.
    COALESCE(
      NULLIF(LOWER(BTRIM(r.source_url)), ''),
      LOWER(BTRIM(COALESCE(r.title, ''))) || '|' || LOWER(BTRIM(COALESCE(r.source_author, '')))
    ) AS dedupe_key
  FROM public.saved_recipes r
  WHERE
    -- Only content from a public source may be shown to strangers. Same
    -- allowlist the adopt route enforces (PUBLIC_SOURCES); manual/scanned/voice
    -- rows are the owner's own content and nobody consented to sharing them.
        r.source_type IN ('instagram', 'web', 'popular')
    -- A failed Instagram re-host leaves an expiring CDN URL behind, and a dead
    -- hero image is worse than no card.
    AND r.image LIKE '%supabase.co/storage/%'
    -- "Rosemary Gnocchi", handed to every older signup (services/defaultRecipe.js).
    -- Without this it tops the ranking with savers who never chose it.
    AND COALESCE(r.import_method, '') <> 'default_seed'
    -- Every account counts, test/internal ones included (see header). Rows
    -- need a user_id to be a "save"; ON DELETE CASCADE means none are orphaned.
    AND r.user_id IS NOT NULL
    -- Imports can succeed with neither; the card and detail screen both break.
    -- jsonb_typeof guards are required: the column defaults to '[]' but nothing
    -- stops a row holding an object or null, and jsonb_array_length on a
    -- non-array raises and would kill the whole query.
    AND jsonb_typeof(r."extendedIngredients") = 'array'
    AND jsonb_array_length(r."extendedIngredients") > 0
    AND jsonb_typeof(r."analyzedInstructions") = 'array'
    AND EXISTS (
      SELECT 1
      FROM jsonb_array_elements(r."analyzedInstructions") AS block
      WHERE jsonb_typeof(block -> 'steps') = 'array'
        AND jsonb_array_length(block -> 'steps') > 0
    )
),
-- Two passes over `eligible` because the count and the representative row are
-- different questions. They cannot be one window pass: Postgres rejects
-- COUNT(DISTINCT ...) OVER (...) with "DISTINCT is not implemented for window
-- functions". `eligible` is referenced twice so PG12+ materializes it once.
counted AS (
  SELECT e.dedupe_key, COUNT(DISTINCT e.user_id) AS saver_count
  FROM eligible e
  GROUP BY e.dedupe_key
  -- If the adopt loop ever entrenches a stale top 5, rank on organic saves
  -- only (carry r.adopted_from through `eligible` first):
  --   COUNT(DISTINCT e.user_id) FILTER (WHERE e.adopted_from IS NULL)
),
representative AS (
  -- OLDEST row represents the group. Adopting keeps the original's source_url
  -- and stamps a fresh created_at, so "newest" would move the card's id every
  -- time someone adopted it — churning deep links and analytics ids. Oldest is
  -- the original import and never moves.
  SELECT DISTINCT ON (e.dedupe_key) e.*
  FROM eligible e
  ORDER BY e.dedupe_key, e.created_at ASC, e.id ASC
)
SELECT
  r.id, r.title::text, r.summary::text, r.image::text,
  r."extendedIngredients", r."readyInMinutes", r.servings,
  r.source_author::text, r.source_type::text, r.source_url::text,
  r.cuisines, r."dishTypes",
  r.vegetarian, r.vegan, r."glutenFree", r."dairyFree",
  r.created_at, c.saver_count
FROM representative r
JOIN counted c USING (dedupe_key)
ORDER BY c.saver_count DESC, r.created_at DESC, r.id ASC
LIMIT GREATEST(1, LEAST(COALESCE(limit_n, 12), 50));
$$;

COMMENT ON FUNCTION public.popular_saved_recipes(integer) IS
  'Home "Popular Now" leaderboard: public-source recipes ranked by COUNT(DISTINCT user_id) over the source_url/title|author dedupe key. Excludes default_seed rows only — test/internal accounts DO count (086). Returns no user_id, user_notes or rating. Backed by GET /api/recipes/popular.';

-- CREATE OR REPLACE keeps the grants from 085; restated so this file is
-- self-sufficient if it is ever run on a fresh database.
REVOKE ALL ON FUNCTION public.popular_saved_recipes(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.popular_saved_recipes(integer) TO service_role;

NOTIFY pgrst, 'reload schema';

-- ---------------------------------------------------------------------------
-- Verify
-- ---------------------------------------------------------------------------
-- 1. Counts should be >= what 085 returned for the same rows; still no
--    "Rosemary Gnocchi".
--   SELECT title, source_author, saver_count FROM public.popular_saved_recipes(20);
--
-- 2. Grants unchanged: expect {postgres=X/postgres,service_role=X/postgres}.
--   SELECT proname, proacl FROM pg_proc WHERE proname = 'popular_saved_recipes';
--
-- 3. anon must still be refused (the 42501 error IS the pass):
--   SET ROLE anon; SELECT * FROM public.popular_saved_recipes(5);
--   RESET ROLE;
--
-- Note: a running backend instance keeps serving the previous ranking from its
-- 6h in-process cache until it expires or the instance restarts. Expected.
