-- Migration: Set up Supabase Storage for ingredient images
-- Run this in Supabase SQL editor to create and configure storage buckets

-- Step 1: Create the storage bucket for ingredient images
INSERT INTO storage.buckets (id, name, public, avif_autodetection, file_size_limit, allowed_mime_types)
VALUES (
  'ingredient-images',
  'ingredient-images', 
  true, -- Public bucket so images can be accessed without authentication
  false,
  5242880, -- 5MB file size limit
  ARRAY['image/png', 'image/jpeg', 'image/jpg', 'image/webp']::text[]
)
ON CONFLICT (id) DO UPDATE
SET 
  public = true,
  file_size_limit = 5242880,
  allowed_mime_types = ARRAY['image/png', 'image/jpeg', 'image/jpg', 'image/webp']::text[];

-- Step 2: Set up RLS policies for the storage bucket
-- Anyone can view images
CREATE POLICY "Public Access" ON storage.objects
  FOR SELECT USING (bucket_id = 'ingredient-images');

-- Only authenticated users can upload (you can restrict to admins later)
CREATE POLICY "Authenticated users can upload ingredient images" ON storage.objects
  FOR INSERT WITH CHECK (
    bucket_id = 'ingredient-images' 
    AND auth.role() = 'authenticated'
  );

-- Only the uploader or admin can update their images
CREATE POLICY "Users can update own ingredient images" ON storage.objects
  FOR UPDATE USING (
    bucket_id = 'ingredient-images' 
    AND (auth.uid() = owner OR auth.jwt() ->> 'role' = 'admin')
  );

-- Only the uploader or admin can delete images
CREATE POLICY "Users can delete own ingredient images" ON storage.objects
  FOR DELETE USING (
    bucket_id = 'ingredient-images' 
    AND (auth.uid() = owner OR auth.jwt() ->> 'role' = 'admin')
  );

-- Step 3: Create a function to generate public URLs for ingredient images
CREATE OR REPLACE FUNCTION get_ingredient_image_url(file_path TEXT)
RETURNS TEXT AS $$
DECLARE
  base_url TEXT;
BEGIN
  -- Get the Supabase project URL from settings
  SELECT 
    CONCAT(
      regexp_replace(current_setting('request.headers')::json->>'origin', '/api/.*', ''),
      '/storage/v1/object/public/ingredient-images/',
      file_path
    )
  INTO base_url;
  
  -- If we can't get the URL from headers, use a placeholder
  IF base_url IS NULL THEN
    RETURN CONCAT('https://[your-project-ref].supabase.co/storage/v1/object/public/ingredient-images/', file_path);
  END IF;
  
  RETURN base_url;
END;
$$ LANGUAGE plpgsql;

-- Step 4: Create helper function to upload image metadata after file upload
CREATE OR REPLACE FUNCTION register_ingredient_image(
  p_ingredient_name TEXT,
  p_file_path TEXT,
  p_category TEXT DEFAULT NULL,
  p_aliases JSONB DEFAULT '[]'::jsonb,
  p_tags JSONB DEFAULT '[]'::jsonb
)
RETURNS UUID AS $$
DECLARE
  image_id UUID;
  full_url TEXT;
BEGIN
  -- Generate the full URL
  full_url := get_ingredient_image_url(p_file_path);
  
  -- Insert into ingredient_images table
  INSERT INTO ingredient_images (
    ingredient_name,
    display_name,
    category,
    image_url,
    image_path,
    aliases,
    tags,
    priority,
    source
  ) VALUES (
    p_ingredient_name,
    p_ingredient_name,
    p_category,
    full_url,
    p_file_path,
    p_aliases,
    p_tags,
    10, -- Default priority
    'manual'
  )
  RETURNING id INTO image_id;
  
  RETURN image_id;
END;
$$ LANGUAGE plpgsql;

-- Step 5: Create a view for easy image management
CREATE OR REPLACE VIEW ingredient_images_view AS
SELECT 
  ii.*,
  COUNT(fi.id) AS usage_count,
  MAX(fi.created_at) AS last_used
FROM ingredient_images ii
LEFT JOIN fridge_items fi ON fi.ingredient_image_id = ii.id
GROUP BY ii.id
ORDER BY ii.priority DESC, ii.ingredient_name;

-- Grant access to the view
GRANT SELECT ON ingredient_images_view TO anon, authenticated;