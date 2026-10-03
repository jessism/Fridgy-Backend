-- Migration 094: remember which recipe(s) a shopping list item came from
-- Date: 2026-10-03
--
-- Additive, safe to re-run. Apply BEFORE deploying the backend that writes it:
-- an insert naming a column that does not exist fails, and the meal-plan
-- generator swallows that error and leaves the new list empty.
--
-- The app's "By recipe" view groups a list by dish. Until now an item kept no
-- trace of its recipe: the only recipe data was the list-level
-- settings.source_recipes array, which says which dishes fed the list but not
-- which item belongs to which.
--
-- One entry per contributing recipe:
--   { "recipe_id": text, "title": text, "image": text|null,
--     "quantity": text|null, "unit": text|null }
--
-- An array, not a single recipe_id column, because the meal-plan generator
-- merges an ingredient shared by two dishes into one row; each dish keeps its
-- own share of the quantity here. recipe_id is text with no foreign key:
-- snapshot recipes from a meal plan have ids like 'snapshot_<title>', and
-- title/image are copied in so the list still reads after a recipe is deleted.
--
-- No new table, so nothing to add for RLS.

ALTER TABLE public.shopping_list_items
  ADD COLUMN IF NOT EXISTS sources JSONB NOT NULL DEFAULT '[]'::jsonb;
