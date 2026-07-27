-- ============================================================================
-- 074: Lock down storage writes — finish neutralizing the leaked anon key
--
-- WHY: after 073 the leaked anon key has zero database access, but it could
-- still upload to tiktok-images, meal-photos and recipe-images, and delete
-- from recipe-images (policies granting {anon} or {public}; the `public`
-- Postgres role includes anon).
--
-- WHY THIS IS SAFE: since backend commit 1dfd6e8 every storage write goes
-- through the service_role client, and service_role bypasses RLS (verified:
-- a service-key upload to tiktok-images succeeds even though no service_role
-- policy grants it). Neither client app contains the Supabase SDK, and our
-- custom JWT auth never produces a Supabase `authenticated` session, so the
-- authenticated-role policies below can never match a real request either.
--
-- The TikTok automation was migrated to SUPABASE_SERVICE_KEY first
-- (trackabite-tiktok-automation commit 4e91ee5) — that must be deployed
-- BEFORE running this, or carousel posting breaks.
--
-- SELECT policies are deliberately KEPT: public buckets serve reads and both
-- apps plus the marketing site hot-link those URLs.
-- ============================================================================

-- tiktok-images: the automation now authenticates with the service key
DROP POLICY IF EXISTS "Allow public uploads" ON storage.objects;

-- recipe-images: writes/deletes come from the backend only
DROP POLICY IF EXISTS "Allow uploads to recipe-images" ON storage.objects;
DROP POLICY IF EXISTS "Allow updates to recipe-images" ON storage.objects;
DROP POLICY IF EXISTS "Allow deletes from recipe-images" ON storage.objects;

-- meal-photos: uploaded by the backend after the app POSTs the image
DROP POLICY IF EXISTS "Anyone can upload meal photos" ON storage.objects;
DROP POLICY IF EXISTS "Users can upload own meal photos" ON storage.objects;
DROP POLICY IF EXISTS "Users can update own meal photos" ON storage.objects;
DROP POLICY IF EXISTS "Users can delete own meal photos" ON storage.objects;

-- ingredient-images: these already denied anon (auth.role()/auth.uid() can
-- never match a custom-JWT request) — dropping them removes dead rules.
DROP POLICY IF EXISTS "Authenticated users can upload ingredient images" ON storage.objects;
DROP POLICY IF EXISTS "Users can update own ingredient images" ON storage.objects;
DROP POLICY IF EXISTS "Users can delete own ingredient images" ON storage.objects;

-- Verify: every remaining policy must be either SELECT (read) or service_role.
-- Any row returned by this query is an unexpected leftover write policy.
SELECT policyname, cmd, roles
FROM pg_policies
WHERE schemaname = 'storage' AND tablename = 'objects'
  AND cmd <> 'SELECT'
  AND NOT ('service_role' = ANY(roles));
