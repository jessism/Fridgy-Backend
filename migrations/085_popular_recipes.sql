-- Migration 085: popular_saved_recipes() — the Home "Popular Now" leaderboard
--
-- Ranks publicly-sourced recipes by how many DISTINCT users saved a copy.
-- There is one saved_recipes row per (user, recipe copy) — no community_recipes
-- table and no source-recipe FK — so "the same recipe" is identified by the same
-- key the rest of the codebase already uses: source_url, else title|author
-- (recipeController.getCommunityPool, and the savedRecipes adopt route).
--
-- Why a function rather than doing this in Node: getCommunityPool ranks inside a
-- 400-newest-row window, which is a proxy, not a count. A real COUNT(DISTINCT
-- user_id) has to see the whole table, and shipping the whole table to Node to
-- count it is silly. adopted_from cannot be the key: two users independently
-- importing the same reel both get NULL.
--
-- Security: SECURITY INVOKER + EXECUTE granted to service_role only. Migration
-- 073 revoked EXECUTE from anon/authenticated, but a NEWLY created function
-- still gets the Postgres default of EXECUTE TO PUBLIC, and anon inherits
-- PUBLIC — so the REVOKE ... FROM PUBLIC below is load-bearing, not belt and
-- braces. SECURITY DEFINER is deliberately NOT used: it would run as the owner
-- and bypass RLS for anyone who could ever reach it.
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
  JOIN public.users u ON u.id = r.user_id      -- INNER: an orphan row has no saver
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
    -- Internal/QA accounts (080/081/084) and the system user that owns the
    -- curated set (063). A curated recipe real users adopted still appears —
    -- their own copies carry the same dedupe key.
    AND u.is_test IS NOT TRUE
    AND u.id <> '00000000-0000-0000-0000-000000000001'::uuid
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
  'Home "Popular Now" leaderboard: public-source recipes ranked by COUNT(DISTINCT user_id) over the source_url/title|author dedupe key. Excludes default_seed rows, test accounts and the system user. Returns no user_id, user_notes or rating. Backed by GET /api/recipes/popular.';

-- Service-role only. The REVOKE FROM PUBLIC is what actually closes it: a new
-- function is created with EXECUTE TO PUBLIC and migration 073's default
-- privileges only cover anon/authenticated by name.
REVOKE ALL ON FUNCTION public.popular_saved_recipes(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.popular_saved_recipes(integer) TO service_role;

-- PostgREST caches the schema; Supabase reloads on DDL, but force it if the
-- first .rpc() call 404s.
NOTIFY pgrst, 'reload schema';

-- ---------------------------------------------------------------------------
-- Verify
-- ---------------------------------------------------------------------------
-- 1. Sanity: titles + counts, and no "Rosemary Gnocchi".
--   SELECT title, source_author, saver_count FROM public.popular_saved_recipes(20);
--
-- 2. Grants: expect only the owner and service_role=X.
--   SELECT proname, proacl FROM pg_proc WHERE proname = 'popular_saved_recipes';
--
-- 3. anon must be refused:
--   SET ROLE anon; SELECT * FROM public.popular_saved_recipes(5); -- permission denied
--   RESET ROLE;
--
-- 4. Cross-check the top row's count by hand. Note is_test excludes the team's
--    own accounts (see 081), so a dev login's saves never move these numbers.
--   SELECT COUNT(DISTINCT r.user_id)
--   FROM saved_recipes r JOIN users u ON u.id = r.user_id
--   WHERE LOWER(BTRIM(r.source_url)) = '<top row source_url>'
--     AND u.is_test IS NOT TRUE
--     AND COALESCE(r.import_method,'') <> 'default_seed';
--
-- 5. Cost (input to the index decision — only add one if this exceeds ~200ms):
--   EXPLAIN (ANALYZE, BUFFERS) SELECT * FROM public.popular_saved_recipes(12);
