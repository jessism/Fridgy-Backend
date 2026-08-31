-- Marks a saved recipe as a copy taken from the Home "Suggested Meal" card,
-- pointing at the row it was copied from.
--
-- Without it the card loops: adopting a community recipe makes it the user's
-- only saved recipe, so the next suggestion falls to the "your most recent
-- save" tier and hands back the very thing they just took. This lets that tier
-- skip it. Lives on the row rather than in device storage so it follows the
-- account across devices and reinstalls.
--
-- Nullable and unconstrained on purpose: the source row may later be deleted by
-- its owner, and losing the marker then would be worse than a dangling id.
-- Column add on an existing table, so no RLS change is needed — saved_recipes
-- already has RLS enabled and the backend writes it as service_role.

ALTER TABLE public.saved_recipes
  ADD COLUMN IF NOT EXISTS adopted_from UUID;

COMMENT ON COLUMN public.saved_recipes.adopted_from IS
  'Source saved_recipes.id when this row was adopted from the community pool; NULL for the user''s own imports.';
