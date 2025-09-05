-- Migration: Add image_url column to fridge_items table
-- This allows each inventory item to have a custom image URL

-- Step 1: Add image_url column to fridge_items
ALTER TABLE fridge_items 
ADD COLUMN IF NOT EXISTS image_url TEXT;

-- Step 2: Add ingredient_image_id to link to ingredient_images table
ALTER TABLE fridge_items 
ADD COLUMN IF NOT EXISTS ingredient_image_id UUID REFERENCES ingredient_images(id);

-- Step 3: Add index for faster lookups
CREATE INDEX IF NOT EXISTS idx_fridge_items_ingredient_image_id 
ON fridge_items(ingredient_image_id);

-- Step 4: Create a function to auto-populate image_url when items are inserted
CREATE OR REPLACE FUNCTION auto_populate_ingredient_image()
RETURNS TRIGGER AS $$
DECLARE
  matched_image RECORD;
BEGIN
  -- Skip if image_url is already provided
  IF NEW.image_url IS NOT NULL THEN
    RETURN NEW;
  END IF;

  -- Try to find a matching image
  SELECT id, image_url INTO matched_image
  FROM match_ingredient_image(NEW.item_name)
  LIMIT 1;

  -- If found, populate the fields
  IF matched_image.id IS NOT NULL THEN
    NEW.ingredient_image_id = matched_image.id;
    NEW.image_url = matched_image.image_url;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Step 5: Create trigger to auto-populate images on insert
DROP TRIGGER IF EXISTS auto_populate_ingredient_image_trigger ON fridge_items;

CREATE TRIGGER auto_populate_ingredient_image_trigger
BEFORE INSERT ON fridge_items
FOR EACH ROW
EXECUTE FUNCTION auto_populate_ingredient_image();

-- Step 6: Create trigger for updates (when item_name changes)
CREATE OR REPLACE FUNCTION update_ingredient_image_on_name_change()
RETURNS TRIGGER AS $$
DECLARE
  matched_image RECORD;
BEGIN
  -- Only proceed if item_name changed and image_url is not manually set
  IF OLD.item_name != NEW.item_name AND 
     (NEW.image_url IS NULL OR NEW.image_url = OLD.image_url) THEN
    
    -- Try to find a new matching image
    SELECT id, image_url INTO matched_image
    FROM match_ingredient_image(NEW.item_name)
    LIMIT 1;

    -- If found, update the fields
    IF matched_image.id IS NOT NULL THEN
      NEW.ingredient_image_id = matched_image.id;
      NEW.image_url = matched_image.image_url;
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Step 7: Create trigger for updates
DROP TRIGGER IF EXISTS update_ingredient_image_trigger ON fridge_items;

CREATE TRIGGER update_ingredient_image_trigger
BEFORE UPDATE ON fridge_items
FOR EACH ROW
EXECUTE FUNCTION update_ingredient_image_on_name_change();

-- Step 8: Backfill existing items with matching images
UPDATE fridge_items fi
SET 
  ingredient_image_id = matched.id,
  image_url = matched.image_url
FROM (
  SELECT DISTINCT ON (fi2.id) 
    fi2.id AS item_id,
    ii.id,
    ii.image_url
  FROM fridge_items fi2
  CROSS JOIN LATERAL (
    SELECT * FROM match_ingredient_image(fi2.item_name)
  ) ii
  WHERE fi2.image_url IS NULL
) matched
WHERE fi.id = matched.item_id;