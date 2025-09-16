-- FIXED Recipe Images Storage Bucket Setup
-- This version works with JWT authentication, not Supabase Auth

-- Step 1: Create the storage bucket for recipe images (if not exists)
INSERT INTO storage.buckets (id, name, public, avif_autodetection, file_size_limit, allowed_mime_types)
VALUES (
  'recipe-images',
  'recipe-images',
  true, -- Public access for recipe images
  false,
  10485760, -- 10MB limit per image
  ARRAY['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/gif']
)
ON CONFLICT (id) DO NOTHING;

-- Step 2: Drop existing restrictive policies
DROP POLICY IF EXISTS "Public can view recipe images" ON storage.objects;
DROP POLICY IF EXISTS "Authenticated users can upload recipe images" ON storage.objects;
DROP POLICY IF EXISTS "Users can update own recipe images" ON storage.objects;
DROP POLICY IF EXISTS "Users can delete own recipe images" ON storage.objects;

-- Step 3: Create PERMISSIVE policies that work with JWT auth

-- Allow anyone to view recipe images (they're public)
CREATE POLICY "Public can view recipe images" ON storage.objects
FOR SELECT
USING (bucket_id = 'recipe-images');

-- Allow ANY authenticated request to upload (we use JWT auth, not Supabase auth)
-- The backend validates the JWT token before allowing upload
CREATE POLICY "Allow uploads to recipe-images" ON storage.objects
FOR INSERT
WITH CHECK (bucket_id = 'recipe-images');

-- Allow updates to recipe images
CREATE POLICY "Allow updates to recipe-images" ON storage.objects
FOR UPDATE
USING (bucket_id = 'recipe-images');

-- Allow deletes from recipe images
CREATE POLICY "Allow deletes from recipe-images" ON storage.objects
FOR DELETE
USING (bucket_id = 'recipe-images');

-- Step 4: Add image_storage_path column to saved_recipes table if not exists
ALTER TABLE saved_recipes
ADD COLUMN IF NOT EXISTS image_storage_path TEXT;

-- Add comment for documentation
COMMENT ON COLUMN saved_recipes.image_storage_path IS 'Storage path for the scanned recipe image in recipe-images bucket';

-- Step 5: Create index for faster lookups
CREATE INDEX IF NOT EXISTS idx_saved_recipes_image_storage_path
ON saved_recipes(image_storage_path)
WHERE image_storage_path IS NOT NULL;

-- IMPORTANT: This allows uploads from any source since we validate JWT tokens in the backend
-- The backend ensures only authenticated users can upload via the JWT middleware