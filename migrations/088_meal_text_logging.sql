-- Migration 088: text-based meal logging.
--
-- "Log meal from text": the user types what they ate, the AI returns
-- ingredients + macros + an estimated price, and (optionally) a generated
-- picture. Photo-logged meals get the same columns (NULL) so history rows
-- stay one shape.
--
-- Additive only, safe to re-run. meal_logs RLS stays as it is (see
-- recreate_meal_logs_correct.sql) — this migration creates no table.
-- The generated-image cache reuses ai_recipe_images (RLS already enabled).
--
-- Apply in the Supabase SQL editor BEFORE deploying the backend that writes
-- these columns: the usage counter increment swallows errors, so a missing
-- meal_text_count would silently make text meals unlimited.

ALTER TABLE public.meal_logs
  ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'photo'
    CHECK (source IN ('photo', 'text')),
  ADD COLUMN IF NOT EXISTS description TEXT,
  ADD COLUMN IF NOT EXISTS total_calories INTEGER
    CHECK (total_calories IS NULL OR total_calories >= 0),
  ADD COLUMN IF NOT EXISTS protein_g NUMERIC(7,1)
    CHECK (protein_g IS NULL OR protein_g >= 0),
  ADD COLUMN IF NOT EXISTS carbs_g NUMERIC(7,1)
    CHECK (carbs_g IS NULL OR carbs_g >= 0),
  ADD COLUMN IF NOT EXISTS fat_g NUMERIC(7,1)
    CHECK (fat_g IS NULL OR fat_g >= 0),
  ADD COLUMN IF NOT EXISTS estimated_price_usd NUMERIC(8,2)
    CHECK (estimated_price_usd IS NULL OR estimated_price_usd >= 0);

COMMENT ON COLUMN public.meal_logs.source IS
  'photo = camera/library scan, text = typed description';
COMMENT ON COLUMN public.meal_logs.description IS
  'Raw text the user typed (text source only)';
COMMENT ON COLUMN public.meal_logs.total_calories IS
  'AI dish total. NULL on legacy rows — clients fall back to summing ingredients_logged';
COMMENT ON COLUMN public.meal_logs.estimated_price_usd IS
  'AI estimate of what the meal cost (menu price for restaurant items, ingredient cost per serving otherwise). NULL when unknown';

ALTER TABLE public.usage_limits
  ADD COLUMN IF NOT EXISTS meal_text_count INTEGER DEFAULT 0
    CHECK (meal_text_count >= 0);

COMMENT ON COLUMN public.usage_limits.meal_text_count IS
  'Text meal analyses this week. Free: 3/week, premium: unlimited. Weekly RATE counter — reset with the others, never synced from a row count.';
