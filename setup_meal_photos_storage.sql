-- Setup script for meal-photos storage bucket in Supabase
-- Run this in your Supabase SQL Editor: https://supabase.com/dashboard/project/aimvjpndmipmtavpmjnn

-- Create the storage bucket if it doesn't exist
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'meal-photos',
  'meal-photos', 
  true,  -- Public bucket so authenticated users can view images
  10485760,  -- 10MB file size limit
  ARRAY['image/jpeg', 'image/jpg', 'image/png', 'image/webp']::text[]
)
ON CONFLICT (id) DO UPDATE
SET 
  public = true,
  file_size_limit = 10485760,
  allowed_mime_types = ARRAY['image/jpeg', 'image/jpg', 'image/png', 'image/webp']::text[];

-- Create RLS policies for the bucket
-- Allow authenticated users to upload their own meal photos
CREATE POLICY "Users can upload own meal photos" ON storage.objects
  FOR INSERT 
  TO authenticated
  WITH CHECK (
    bucket_id = 'meal-photos' AND 
    (storage.foldername(name))[1] = auth.uid()::text
  );

-- Allow authenticated users to view all meal photos
CREATE POLICY "Users can view meal photos" ON storage.objects
  FOR SELECT
  TO authenticated
  USING (bucket_id = 'meal-photos');

-- Allow users to update their own meal photos
CREATE POLICY "Users can update own meal photos" ON storage.objects
  FOR UPDATE
  TO authenticated
  USING (
    bucket_id = 'meal-photos' AND 
    (storage.foldername(name))[1] = auth.uid()::text
  );

-- Allow users to delete their own meal photos
CREATE POLICY "Users can delete own meal photos" ON storage.objects
  FOR DELETE
  TO authenticated
  USING (
    bucket_id = 'meal-photos' AND 
    (storage.foldername(name))[1] = auth.uid()::text
  );