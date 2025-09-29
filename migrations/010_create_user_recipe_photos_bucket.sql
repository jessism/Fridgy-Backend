-- Migration: Create user-recipe-photos storage bucket
-- Purpose: Store user-uploaded recipe photos with clear copyright ownership
-- Date: 2025-01-18

-- Note: This migration needs to be run with admin privileges
-- Some operations may need to be done via Supabase Dashboard

-- Create the storage bucket for user recipe photos
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'user-recipe-photos',
  'user-recipe-photos',
  true, -- Public bucket so images can be displayed
  5242880, -- 5MB limit per file
  ARRAY['image/jpeg', 'image/png', 'image/webp', 'image/gif']::text[]
)
ON CONFLICT (id) DO NOTHING;

-- Set up RLS policies for the bucket
-- Users can only upload to their own folder
CREATE POLICY "Users can upload their own recipe photos"
ON storage.objects
FOR INSERT
TO authenticated
WITH CHECK (
  bucket_id = 'user-recipe-photos' AND
  (storage.foldername(name))[1] = auth.uid()::text
);

-- Users can update their own recipe photos
CREATE POLICY "Users can update their own recipe photos"
ON storage.objects
FOR UPDATE
TO authenticated
USING (
  bucket_id = 'user-recipe-photos' AND
  (storage.foldername(name))[1] = auth.uid()::text
);

-- Users can delete their own recipe photos
CREATE POLICY "Users can delete their own recipe photos"
ON storage.objects
FOR DELETE
TO authenticated
USING (
  bucket_id = 'user-recipe-photos' AND
  (storage.foldername(name))[1] = auth.uid()::text
);

-- Anyone can view recipe photos (public bucket)
CREATE POLICY "Anyone can view recipe photos"
ON storage.objects
FOR SELECT
TO public
USING (bucket_id = 'user-recipe-photos');

-- Add comment for documentation
COMMENT ON COLUMN storage.buckets.id IS 'user-recipe-photos: Stores user-uploaded recipe photos. Users retain copyright. Structure: {userId}/manual/{timestamp}_{id}.jpg';

-- Instructions for manual setup (if needed):
-- 1. Go to Supabase Dashboard > Storage
-- 2. Create new bucket called "user-recipe-photos"
-- 3. Set as Public bucket
-- 4. Set file size limit to 5MB
-- 5. Set allowed MIME types to: image/jpeg, image/png, image/webp, image/gif
-- 6. Apply RLS policies as defined above