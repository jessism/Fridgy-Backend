-- Migration: Create ingredient_images table for storing real food images
-- This table will store URLs and metadata for real ingredient PNG images

-- Step 1: Create the ingredient_images table
CREATE TABLE IF NOT EXISTS ingredient_images (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  ingredient_name VARCHAR(255) NOT NULL,
  display_name VARCHAR(255),
  category VARCHAR(100),
  image_url TEXT NOT NULL, -- Full URL to the image (Supabase storage or CDN)
  image_path TEXT, -- Relative path in storage bucket
  thumbnail_url TEXT, -- Optional smaller version for lists
  aliases JSONB DEFAULT '[]'::jsonb, -- Array of alternative names
  tags JSONB DEFAULT '[]'::jsonb, -- Additional searchable tags
  priority INTEGER DEFAULT 0, -- Higher priority images shown first
  is_active BOOLEAN DEFAULT true,
  source VARCHAR(100), -- Source of image (unsplash, pexels, ai-generated, manual)
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Step 2: Create indexes for fast lookups
CREATE INDEX idx_ingredient_images_name ON ingredient_images(LOWER(ingredient_name));
CREATE INDEX idx_ingredient_images_category ON ingredient_images(category);
CREATE INDEX idx_ingredient_images_active ON ingredient_images(is_active);
CREATE INDEX idx_ingredient_images_priority ON ingredient_images(priority DESC);

-- Add GIN index for JSONB searches on aliases and tags
CREATE INDEX idx_ingredient_images_aliases ON ingredient_images USING gin(aliases);
CREATE INDEX idx_ingredient_images_tags ON ingredient_images USING gin(tags);

-- Step 3: Create a function for fuzzy matching ingredient names
CREATE OR REPLACE FUNCTION match_ingredient_image(search_term TEXT)
RETURNS TABLE (
  id UUID,
  ingredient_name VARCHAR,
  image_url TEXT,
  match_score INTEGER
) AS $$
BEGIN
  RETURN QUERY
  WITH matches AS (
    SELECT 
      i.id,
      i.ingredient_name,
      i.image_url,
      CASE
        -- Exact match (case-insensitive)
        WHEN LOWER(i.ingredient_name) = LOWER(search_term) THEN 100
        -- Exact match in aliases
        WHEN i.aliases @> to_jsonb(LOWER(search_term)) THEN 95
        -- Starts with search term
        WHEN LOWER(i.ingredient_name) LIKE LOWER(search_term) || '%' THEN 90
        -- Contains search term
        WHEN LOWER(i.ingredient_name) LIKE '%' || LOWER(search_term) || '%' THEN 80
        -- Search term in aliases (partial)
        WHEN EXISTS (
          SELECT 1 FROM jsonb_array_elements_text(i.aliases) AS alias
          WHERE LOWER(alias) LIKE '%' || LOWER(search_term) || '%'
        ) THEN 75
        -- Search term in tags
        WHEN EXISTS (
          SELECT 1 FROM jsonb_array_elements_text(i.tags) AS tag
          WHERE LOWER(tag) LIKE '%' || LOWER(search_term) || '%'
        ) THEN 70
        ELSE 0
      END AS match_score,
      i.priority
    FROM ingredient_images i
    WHERE i.is_active = true
  )
  SELECT 
    matches.id,
    matches.ingredient_name,
    matches.image_url,
    matches.match_score
  FROM matches
  WHERE matches.match_score > 0
  ORDER BY matches.match_score DESC, matches.priority DESC
  LIMIT 1;
END;
$$ LANGUAGE plpgsql;

-- Step 4: Create update trigger for updated_at
CREATE TRIGGER update_ingredient_images_updated_at
BEFORE UPDATE ON ingredient_images
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();

-- Step 5: Enable Row Level Security
ALTER TABLE ingredient_images ENABLE ROW LEVEL SECURITY;

-- Step 6: Create RLS policies - ingredient images are public read
CREATE POLICY "Anyone can view ingredient images" ON ingredient_images
  FOR SELECT USING (true);

-- Only authenticated users with admin role can modify (you'll need to implement admin check)
CREATE POLICY "Only admins can insert ingredient images" ON ingredient_images
  FOR INSERT WITH CHECK (auth.jwt() ->> 'role' = 'admin' OR auth.jwt() ->> 'email' = 'admin@fridgy.app');

CREATE POLICY "Only admins can update ingredient images" ON ingredient_images
  FOR UPDATE USING (auth.jwt() ->> 'role' = 'admin' OR auth.jwt() ->> 'email' = 'admin@fridgy.app');

CREATE POLICY "Only admins can delete ingredient images" ON ingredient_images
  FOR DELETE USING (auth.jwt() ->> 'role' = 'admin' OR auth.jwt() ->> 'email' = 'admin@fridgy.app');

-- Step 7: Grant permissions
GRANT SELECT ON ingredient_images TO anon, authenticated;
GRANT ALL ON ingredient_images TO authenticated;

-- Step 8: Insert some example data (you can remove this in production)
INSERT INTO ingredient_images (ingredient_name, display_name, category, image_url, aliases, tags, priority) VALUES
  ('Apple', 'Apple', 'Fruits', 'https://placeholder.com/apple.png', '["apples", "green apple", "red apple"]'::jsonb, '["fruit", "healthy", "snack"]'::jsonb, 10),
  ('Carrot', 'Carrot', 'Vegetables', 'https://placeholder.com/carrot.png', '["carrots", "baby carrots"]'::jsonb, '["vegetable", "root", "orange"]'::jsonb, 10),
  ('Milk', 'Milk', 'Dairy', 'https://placeholder.com/milk.png', '["whole milk", "2% milk", "skim milk"]'::jsonb, '["dairy", "beverage", "calcium"]'::jsonb, 10)
ON CONFLICT DO NOTHING;