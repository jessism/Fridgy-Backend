-- Migration: Add image_urls array field to saved_recipes table
-- This adds support for multiple image URLs to match frontend expectations

-- Add image_urls array column to saved_recipes table
ALTER TABLE saved_recipes
ADD COLUMN IF NOT EXISTS image_urls TEXT[] DEFAULT '{}';

-- Add index for faster lookups when image_urls is populated
CREATE INDEX IF NOT EXISTS idx_saved_recipes_image_urls
ON saved_recipes USING GIN (image_urls)
WHERE array_length(image_urls, 1) > 0;

-- Add comment for documentation
COMMENT ON COLUMN saved_recipes.image_urls IS 'Array of image URLs for recipes with multiple images (primarily from Instagram)';

-- Populate existing recipes that have a single image
-- Convert existing image field to first element of image_urls array for consistency
UPDATE saved_recipes
SET image_urls = ARRAY[image]
WHERE image IS NOT NULL
  AND image != ''
  AND (image_urls IS NULL OR array_length(image_urls, 1) IS NULL);

-- Optional: Create function to keep image and image_urls in sync
CREATE OR REPLACE FUNCTION sync_recipe_images()
RETURNS TRIGGER AS $$
BEGIN
  -- When image_urls is updated, set image to first URL
  IF array_length(NEW.image_urls, 1) > 0 AND NEW.image_urls[1] IS NOT NULL THEN
    NEW.image = NEW.image_urls[1];
  END IF;

  -- When image is updated, ensure it's in image_urls array
  IF NEW.image IS NOT NULL AND NEW.image != '' THEN
    -- Only update if image_urls is empty or doesn't contain the image
    IF array_length(NEW.image_urls, 1) IS NULL OR NOT (NEW.image = ANY(NEW.image_urls)) THEN
      NEW.image_urls = array_prepend(NEW.image, COALESCE(NEW.image_urls, '{}'));
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create trigger to automatically sync image and image_urls
DROP TRIGGER IF EXISTS sync_recipe_images_trigger ON saved_recipes;
CREATE TRIGGER sync_recipe_images_trigger
  BEFORE INSERT OR UPDATE ON saved_recipes
  FOR EACH ROW
  EXECUTE FUNCTION sync_recipe_images();