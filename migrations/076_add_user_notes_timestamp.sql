-- 076: Track when a recipe's personal note was last written.
-- The row's updated_at moves on any edit (tags, favorite, image), so the
-- mobile "My Notes" card needs its own timestamp. Set server-side by the
-- PUT/PATCH /saved-recipes/:id handlers whenever user_notes is in the body.
-- (Existing table — RLS already enabled; no policy changes needed.)

ALTER TABLE public.saved_recipes
  ADD COLUMN IF NOT EXISTS user_notes_updated_at TIMESTAMPTZ;
