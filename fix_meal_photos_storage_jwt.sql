-- Fix Storage Bucket for JWT Authentication
-- Problem: The current RLS policies require Supabase Auth (auth.uid()) but the app uses custom JWT auth
-- Solution: Update policies to work with anonymous access since the bucket is public

-- Step 1: Drop all existing restrictive RLS policies that require auth.uid()
DROP POLICY IF EXISTS "Users can upload own meal photos" ON storage.objects;
DROP POLICY IF EXISTS "Users can view meal photos" ON storage.objects;
DROP POLICY IF EXISTS "Users can update own meal photos" ON storage.objects;
DROP POLICY IF EXISTS "Users can delete own meal photos" ON storage.objects;

-- Step 2: Ensure the bucket exists and is public
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'meal-photos',
  'meal-photos', 
  true,  -- Public bucket for viewing
  10485760,  -- 10MB file size limit
  ARRAY['image/jpeg', 'image/jpg', 'image/png', 'image/webp']::text[]
)
ON CONFLICT (id) DO UPDATE
SET 
  public = true,
  file_size_limit = 10485760,
  allowed_mime_types = ARRAY['image/jpeg', 'image/jpg', 'image/png', 'image/webp']::text[];

-- Step 3: Create new policies that work with anon access (for JWT auth apps)
-- Allow anyone to upload meal photos (backend will handle auth via JWT)
CREATE POLICY "Anyone can upload meal photos" ON storage.objects
  FOR INSERT 
  TO anon, authenticated
  WITH CHECK (bucket_id = 'meal-photos');

-- Allow anyone to view meal photos (public bucket)
CREATE POLICY "Anyone can view meal photos" ON storage.objects
  FOR SELECT
  TO anon, authenticated, public
  USING (bucket_id = 'meal-photos');

-- Allow anyone to update meal photos (backend handles auth)
CREATE POLICY "Anyone can update meal photos" ON storage.objects
  FOR UPDATE
  TO anon, authenticated
  USING (bucket_id = 'meal-photos')
  WITH CHECK (bucket_id = 'meal-photos');

-- Allow anyone to delete meal photos (backend handles auth)
CREATE POLICY "Anyone can delete meal photos" ON storage.objects
  FOR DELETE
  TO anon, authenticated
  USING (bucket_id = 'meal-photos');

-- Step 4: Verify the bucket is properly configured
SELECT 
  id,
  name,
  public,
  file_size_limit,
  allowed_mime_types,
  created_at,
  updated_at
FROM storage.buckets
WHERE id = 'meal-photos';

-- Step 5: Check that RLS is enabled but with our new permissive policies
SELECT 
  schemaname, 
  tablename, 
  policyname, 
  permissive, 
  roles, 
  cmd, 
  qual, 
  with_check
FROM pg_policies 
WHERE tablename = 'objects' 
  AND schemaname = 'storage'
  AND policyname LIKE '%meal photos%';

-- Expected result: You should see 4 policies all allowing anon access to the meal-photos bucket
-- After running this, test by logging a new meal with a photo