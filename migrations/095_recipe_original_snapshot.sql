-- Migration 095: saved_recipes.original_snapshot — public surfaces serve the
-- original, the owner keeps their edits
--
-- Problem: Popular Now, the community pool, GET /saved-recipes/:id/public and
-- the adopt route all read a user's saved_recipes row LIVE. Popular Now shows
-- the oldest copy of each recipe, so when the first importer edits their copy
-- (title, ingredients, photo) every other user sees the edited version.
--
-- Fix (product call 2026-10-03): the first time the owner of a PUBLIC-source
-- row (instagram/facebook/tiktok/web/popular) edits it, the backend copies the
-- pre-edit content into original_snapshot before applying the edit
-- (routes/savedRecipes.js PUT/PATCH, services/recipeShareService.js). Public
-- surfaces overlay that snapshot; the owner's own reads are untouched. Share
-- links (/r/<slug>) deliberately keep serving the live, edited row — sharing
-- is the owner's choice.
--
-- NULL = never edited; the live row IS the original. Private-source rows never
-- get a snapshot (they are never shown to strangers).
--
-- Rows edited BEFORE this migration have no snapshot and cannot be recovered.
-- The representative tie-break below demotes them when an unedited copy of
-- the same recipe exists.
--
-- Same function signature as 085-092; body differs in reading "effective"
-- (snapshot-or-live) values and in the representative ordering.
--
-- To REVERT the function: re-run 092 in full (the column may stay; it is
-- harmless when nothing reads it).
--
-- Apply in the Supabase SQL editor (safe to re-run).

ALTER TABLE public.saved_recipes
  ADD COLUMN IF NOT EXISTS original_snapshot JSONB;

COMMENT ON COLUMN public.saved_recipes.original_snapshot IS
  'Pre-first-edit content of a PUBLIC-source row (title, summary, image, extendedIngredients, analyzedInstructions, ...; see SNAPSHOT_FIELDS in services/recipeShareService.js). Written once by PUT/PATCH /saved-recipes/:id, never by the client. NULL = never edited, the live row is the original. Popular Now, community pool, /:id/public and adopt serve this when present; /share/:slug serves the live row.';

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
WITH effective AS (
  -- "What the public should see" for every row: the pre-edit snapshot when
  -- the owner has edited a public-source row, else the live row. Every filter
  -- and the dedupe key below run on these values, so a retitled copy stays in
  -- its original group and an emptied ingredient list doesn't drop the
  -- original from the shelf.
  SELECT
    r.id, r.user_id, r.source_type, r.import_method, r.created_at,
    r.user_edited, (r.original_snapshot IS NOT NULL) AS has_snapshot,
    COALESCE(r.original_snapshot ->> 'title',         r.title)         AS title,
    COALESCE(r.original_snapshot ->> 'summary',       r.summary)       AS summary,
    -- The share-time re-host writes a durable URL back onto the LIVE row, so
    -- only prefer the snapshot's image when it is itself durable.
    CASE
      WHEN COALESCE(r.original_snapshot ->> 'image', '') LIKE '%supabase.co/storage/%'
        THEN r.original_snapshot ->> 'image'
      ELSE r.image
    END AS image,
    COALESCE(r.original_snapshot -> 'extendedIngredients',  r."extendedIngredients")  AS "extendedIngredients",
    COALESCE(r.original_snapshot -> 'analyzedInstructions', r."analyzedInstructions") AS "analyzedInstructions",
    COALESCE((r.original_snapshot ->> 'readyInMinutes')::integer, r."readyInMinutes") AS "readyInMinutes",
    COALESCE((r.original_snapshot ->> 'servings')::integer,       r.servings)         AS servings,
    COALESCE(r.original_snapshot ->> 'source_author', r.source_author) AS source_author,
    COALESCE(r.original_snapshot ->> 'source_url',    r.source_url)    AS source_url,
    r.cuisines, r."dishTypes",
    r.vegetarian, r.vegan, r."glutenFree", r."dairyFree"
  FROM public.saved_recipes r
  WHERE
    -- Only content from a public source may be shown to strangers. Must match
    -- PUBLIC_SOURCES in services/recipeShareService.js, which the adopt route
    -- enforces; manual/scanned/voice rows are the owner's own content and
    -- nobody consented to sharing them.
        r.source_type IN ('instagram', 'facebook', 'tiktok', 'web', 'popular')
    -- "Rosemary Gnocchi", handed to every older signup (services/defaultRecipe.js).
    AND COALESCE(r.import_method, '') <> 'default_seed'
    -- Rows need a user_id to be a "save"; ON DELETE CASCADE means none are orphaned.
    AND r.user_id IS NOT NULL
),
eligible AS (
  SELECT
    e.*,
    -- Same key as recipeController.js dedupeKey(); keep the two in step.
    COALESCE(
      NULLIF(LOWER(BTRIM(e.source_url)), ''),
      LOWER(BTRIM(COALESCE(e.title, ''))) || '|' || LOWER(BTRIM(COALESCE(e.source_author, '')))
    ) AS dedupe_key
  FROM effective e
  WHERE
    -- A failed Instagram re-host leaves an expiring CDN URL behind, and a dead
    -- hero image is worse than no card.
        e.image LIKE '%supabase.co/storage/%'
    -- Blocklist (087): healthygirlkitchen's rosemary gnocchi reel DGioQ5qOWij,
    -- the recipe the default seed was built from. Both tests, because two of
    -- the variants have no source_url at all.
    AND COALESCE(e.source_url, '') NOT ILIKE '%DGioQ5qOWij%'
    AND COALESCE(e.title, '')      NOT ILIKE '%rosemary gnocchi%'
    -- Imports can succeed with neither; the card and detail screen both break.
    -- jsonb_typeof guards are required: nothing stops a row (or a snapshot)
    -- holding an object or null, and jsonb_array_length on a non-array raises.
    AND jsonb_typeof(e."extendedIngredients") = 'array'
    AND jsonb_array_length(e."extendedIngredients") > 0
    AND jsonb_typeof(e."analyzedInstructions") = 'array'
    AND EXISTS (
      SELECT 1
      FROM jsonb_array_elements(e."analyzedInstructions") AS block
      WHERE jsonb_typeof(block -> 'steps') = 'array'
        AND jsonb_array_length(block -> 'steps') > 0
    )
),
-- Two passes over `eligible` because the count and the representative row are
-- different questions (COUNT(DISTINCT) is not a window function).
counted AS (
  SELECT e.dedupe_key, COUNT(DISTINCT e.user_id) AS saver_count
  FROM eligible e
  GROUP BY e.dedupe_key
),
representative AS (
  -- OLDEST row represents the group so the card's id never churns (adopting
  -- stamps a fresh created_at). One exception: a row edited BEFORE 095 has no
  -- snapshot and would show its owner's edits, so such rows are demoted below
  -- any copy that is unedited or has a snapshot. Rows WITH a snapshot already
  -- serve the original, so editing after 095 never moves the card.
  SELECT DISTINCT ON (e.dedupe_key) e.*
  FROM eligible e
  ORDER BY
    e.dedupe_key,
    (COALESCE(e.user_edited, false) AND NOT e.has_snapshot) ASC,
    e.created_at ASC,
    e.id ASC
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
  'Home "Popular Now" leaderboard: public-source (instagram/facebook/tiktok/web/popular) recipes ranked by COUNT(DISTINCT user_id) over the source_url/title|author dedupe key. Reads original_snapshot (095) over the live row so owner edits stay private. Excludes default_seed rows and the rosemary gnocchi reel DGioQ5qOWij (087 blocklist); test/internal accounts DO count (086). Returns no user_id, user_notes or rating. Backed by GET /api/recipes/popular.';

-- CREATE OR REPLACE keeps the grants from 085/086; restated so this file is
-- self-sufficient if it is ever run on a fresh database.
REVOKE ALL ON FUNCTION public.popular_saved_recipes(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.popular_saved_recipes(integer) TO service_role;

NOTIFY pgrst, 'reload schema';

-- ---------------------------------------------------------------------------
-- Verify
-- ---------------------------------------------------------------------------
-- 1. Column exists and is empty until someone edits a public-source recipe:
--   SELECT COUNT(*) FILTER (WHERE original_snapshot IS NOT NULL) AS snapshotted,
--          COUNT(*) FILTER (WHERE user_edited) AS edited
--   FROM public.saved_recipes
--   WHERE source_type IN ('instagram','facebook','tiktok','web','popular');
--
-- 2. Shelf still renders (12 rows, same leaders as before 095):
--   SELECT title, source_type, saver_count FROM public.popular_saved_recipes(12);
--
-- 3. After the backend is deployed and a public-source recipe has been edited
--    once, the shelf shows the ORIGINAL title, not the edited one:
--   SELECT p.title AS public_title, r.title AS owner_title
--   FROM public.popular_saved_recipes(50) p JOIN public.saved_recipes r USING (id)
--   WHERE r.original_snapshot IS NOT NULL;
--
-- 4. The 087 blocklist still holds; this must return 0:
--   SELECT COUNT(*) FROM public.popular_saved_recipes(50)
--   WHERE title ILIKE '%rosemary gnocchi%' OR COALESCE(source_url,'') ILIKE '%DGioQ5qOWij%';
--
-- 5. Grants unchanged: expect {postgres=X/postgres,service_role=X/postgres}.
--   SELECT proname, proacl FROM pg_proc WHERE proname = 'popular_saved_recipes';
--
-- 6. anon must still be refused (the 42501 error IS the pass):
--   SET ROLE anon; SELECT * FROM public.popular_saved_recipes(5);
--   RESET ROLE;
--
-- Note: a running backend instance keeps serving the previous ranking from its
-- 6h in-process cache until it expires or the instance restarts (the Railway
-- deploy of the matching backend commit restarts it).
