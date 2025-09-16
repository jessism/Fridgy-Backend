-- Recipe Images Storage Bucket Setup
-- Run this in Supabase SQL editor to create storage for scanned recipe photos

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

-- Step 2: Set up RLS policies for the storage bucket

-- Drop existing policies if they exist
DROP POLICY IF EXISTS "Public can view recipe images" ON storage.objects;
DROP POLICY IF EXISTS "Authenticated users can upload recipe images" ON storage.objects;
DROP POLICY IF EXISTS "Users can update own recipe images" ON storage.objects;
DROP POLICY IF EXISTS "Users can delete own recipe images" ON storage.objects;

-- Allow public read access to all recipe images
CREATE POLICY "Public can view recipe images" ON storage.objects
FOR SELECT USING (bucket_id = 'recipe-images');

-- Allow authenticated users to upload recipe images
CREATE POLICY "Authenticated users can upload recipe images" ON storage.objects
FOR INSERT
TO authenticated
WITH CHECK (
  bucket_id = 'recipe-images'
  AND (auth.uid())::text = (storage.foldername(name))[1]
);

-- Allow users to update their own recipe images
CREATE POLICY "Users can update own recipe images" ON storage.objects
FOR UPDATE
TO authenticated
USING (
  bucket_id = 'recipe-images'
  AND (auth.uid())::text = (storage.foldername(name))[1]
);

-- Allow users to delete their own recipe images
CREATE POLICY "Users can delete own recipe images" ON storage.objects
FOR DELETE
TO authenticated
USING (
  bucket_id = 'recipe-images'
  AND (auth.uid())::text = (storage.foldername(name))[1]
);

-- Step 3: Add image_storage_path column to saved_recipes table if not exists
ALTER TABLE saved_recipes
ADD COLUMN IF NOT EXISTS image_storage_path TEXT;

-- Add comment for documentation
COMMENT ON COLUMN saved_recipes.image_storage_path IS 'Storage path for the scanned recipe image in recipe-images bucket';

-- Step 4: Create index for faster lookups
CREATE INDEX IF NOT EXISTS idx_saved_recipes_image_storage_path
ON saved_recipes(image_storage_path)
WHERE image_storage_path IS NOT NULL;