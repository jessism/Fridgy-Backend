-- Migration 083: Insights capture — usage snapshots, waste reasons, cook events
-- Date: 2026-09-01
--
-- ⚠️ Apply this file as a WHOLE in the Supabase SQL editor (scripts/runMigration.js
--    splits on semicolons). There is no migration ledger: run the PRE-CHECK first
--    and read its output before continuing.
--
-- Deploy order: run this migration → push Backend → ship the mobile OTA.
-- The backend tolerates this not being applied yet (falls back on 42703), but
-- consumption snapshots and waste reasons are only recorded once it is.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- PRE-CHECK (read-only). Expected: inventory_usage_item_id_fkey ON DELETE CASCADE
-- (left as-is — the soft-delete change means it no longer fires), and possibly a
-- CHECK (quantity > 0) on fridge_items (documented in Frontend/SUPABASE_SETUP.md;
-- the code never writes quantity = 0, so it is compatible either way).
--
--   SELECT conrelid::regclass AS table, conname, pg_get_constraintdef(oid)
--   FROM pg_constraint
--   WHERE conrelid IN ('public.inventory_usage'::regclass, 'public.fridge_items'::regclass)
--   ORDER BY 1, 2;
-- ─────────────────────────────────────────────────────────────────────────────

-- Step 1: inventory_usage — snapshot the item so the usage row outlives the item.
-- Before this, "most used ingredients" silently dropped every fully-consumed
-- item because the FK embed had nothing to resolve to.
ALTER TABLE public.inventory_usage
  ADD COLUMN IF NOT EXISTS item_name TEXT,
  ADD COLUMN IF NOT EXISTS category  TEXT;

UPDATE public.inventory_usage u
SET item_name = f.item_name,
    category  = f.category
FROM public.fridge_items f
WHERE u.item_id = f.id
  AND u.item_name IS NULL;

CREATE INDEX IF NOT EXISTS idx_inventory_usage_user_used_at
  ON public.inventory_usage (user_id, used_at DESC);

-- Step 2: fridge_items.waste_reason — optional "why?" when an item is thrown away.
-- NULL = user skipped. Only meaningful when delete_reason = 'thrown_away'.
ALTER TABLE public.fridge_items
  ADD COLUMN IF NOT EXISTS waste_reason VARCHAR(32);

ALTER TABLE public.fridge_items
  DROP CONSTRAINT IF EXISTS fridge_items_waste_reason_check;
ALTER TABLE public.fridge_items
  ADD CONSTRAINT fridge_items_waste_reason_check
  CHECK (waste_reason IS NULL OR waste_reason IN
    ('expired', 'spoiled_early', 'cooked_too_much', 'didnt_like', 'other'));

COMMENT ON COLUMN public.fridge_items.waste_reason IS
  'Optional reason chip chosen when delete_reason = thrown_away. NULL = skipped.';

-- The analytics window query: soft-deleted rows for a user, newest first.
CREATE INDEX IF NOT EXISTS idx_fridge_items_user_deleted_at
  ON public.fridge_items (user_id, deleted_at DESC)
  WHERE deleted_at IS NOT NULL;

-- Step 3: cook_events — one row per Cooking Mode completion (mobile ✓ button).
-- Note: on mobile, Cooking Mode does NOT deduct inventory; only meal logging
-- does. This table is what makes "most cooked recipe" and "cooking rescued N
-- items about to expire" computable at all.
CREATE TABLE IF NOT EXISTS public.cook_events (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  -- Points at saved_recipes only. AI / popular recipes cooked before being
  -- saved leave this NULL and are grouped by recipe_name_key instead.
  recipe_id           UUID REFERENCES public.saved_recipes(id) ON DELETE SET NULL,
  recipe_source       TEXT NOT NULL DEFAULT 'unsaved'
                        CHECK (recipe_source IN ('saved', 'ai', 'popular', 'community', 'unsaved')),
  recipe_name         TEXT NOT NULL,
  -- lower(trim(name)) so "most cooked" survives the recipe being deleted or
  -- re-saved under a new id.
  recipe_name_key     TEXT GENERATED ALWAYS AS (lower(btrim(recipe_name))) STORED,
  cuisines            TEXT[] NOT NULL DEFAULT '{}',
  ingredients_used    JSONB,                       -- [{ name, amount, unit }]
  items_rescued_count INTEGER NOT NULL DEFAULT 0,  -- live items expiring ≤3 days matched to an ingredient
  servings            INTEGER,
  step_count          INTEGER,
  duration_seconds    INTEGER,
  cooked_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cook_events_user_cooked_at
  ON public.cook_events (user_id, cooked_at DESC);
CREATE INDEX IF NOT EXISTS idx_cook_events_user_name_key
  ON public.cook_events (user_id, recipe_name_key);

-- Post-073 rule: every new table enables RLS, gets NO anon/authenticated grants
-- and NO policies. service_role (the only client, via getServiceClient) bypasses
-- RLS; anon/authenticated therefore have zero access. REVOKE is belt and braces
-- on top of the default privileges set in 073.
ALTER TABLE public.cook_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.cook_events FROM anon, authenticated;

-- Step 4: make PostgREST pick up the new columns/table immediately.
NOTIFY pgrst, 'reload schema';
