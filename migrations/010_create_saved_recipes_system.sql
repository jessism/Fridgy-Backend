-- Instagram Recipe Import System Database Schema
-- This migration creates tables for saving recipes from Instagram and other sources

-- Main table for saved recipes (matching existing RecipeDetailModal structure)
CREATE TABLE IF NOT EXISTS saved_recipes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  
  -- Source tracking
  source_type VARCHAR(50) NOT NULL DEFAULT 'instagram', -- instagram, web, manual
  source_url TEXT,
  source_author VARCHAR(255),
  source_author_image TEXT,
  import_method VARCHAR(50) DEFAULT 'ios_shortcut', -- ios_shortcut, web_paste, telegram
  
  -- Recipe content (matching RecipeDetailModal expectations)
  title VARCHAR(255) NOT NULL,
  summary TEXT, -- Description for the recipe
  image TEXT, -- Primary image URL
  
  -- CRITICAL: Match existing RecipeDetailModal structure
  "extendedIngredients" JSONB DEFAULT '[]'::jsonb, -- Array matching Spoonacular format
  "analyzedInstructions" JSONB DEFAULT '[]'::jsonb, -- Array with steps matching format
  
  -- Time and servings (matching existing fields)
  "readyInMinutes" INTEGER,
  "cookingMinutes" INTEGER,
  servings INTEGER DEFAULT 4,
  
  -- Dietary attributes (matching existing RecipeDetailModal)
  vegetarian BOOLEAN DEFAULT false,
  vegan BOOLEAN DEFAULT false,
  "glutenFree" BOOLEAN DEFAULT false,
  "dairyFree" BOOLEAN DEFAULT false,
  "veryHealthy" BOOLEAN DEFAULT false,
  cheap BOOLEAN DEFAULT false,
  "veryPopular" BOOLEAN DEFAULT false,
  
  -- Additional recipe metadata
  cuisines TEXT[] DEFAULT '{}',
  "dishTypes" TEXT[] DEFAULT '{}',
  diets TEXT[] DEFAULT '{}',
  occasions TEXT[] DEFAULT '{}',
  
  -- Nutrition (optional - will be null initially)
  nutrition JSONB,
  
  -- AI extraction metadata
  extraction_confidence FLOAT,
  extraction_notes TEXT,
  missing_info TEXT[] DEFAULT '{}',
  ai_model_used VARCHAR(100),
  
  -- User interaction
  user_edited BOOLEAN DEFAULT false,
  user_notes TEXT,
  times_cooked INTEGER DEFAULT 0,
  last_cooked TIMESTAMP,
  rating INTEGER CHECK (rating >= 1 AND rating <= 5),
  is_favorite BOOLEAN DEFAULT false,
  
  -- Timestamps
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Authentication tokens for iOS shortcuts
CREATE TABLE IF NOT EXISTS shortcut_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  token VARCHAR(255) UNIQUE NOT NULL,
  name VARCHAR(100) DEFAULT 'iOS Shortcut',
  device_info JSONB,
  
  -- Usage tracking
  usage_count INTEGER DEFAULT 0,
  last_used TIMESTAMP,
  daily_usage_count INTEGER DEFAULT 0,
  daily_usage_reset TIMESTAMP DEFAULT NOW(),
  
  -- Security
  is_active BOOLEAN DEFAULT true,
  expires_at TIMESTAMP DEFAULT NOW() + INTERVAL '1 year',
  created_at TIMESTAMP DEFAULT NOW()
);

-- Recipe collections for organization
CREATE TABLE IF NOT EXISTS recipe_collections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  name VARCHAR(100) NOT NULL,
  description TEXT,
  icon VARCHAR(50) DEFAULT '📁',
  color VARCHAR(7) DEFAULT '#4fcf61',
  sort_order INTEGER DEFAULT 0,
  is_default BOOLEAN DEFAULT false,
  recipe_count INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Many-to-many relationship for recipes in collections
CREATE TABLE IF NOT EXISTS recipe_collection_items (
  collection_id UUID REFERENCES recipe_collections(id) ON DELETE CASCADE,
  recipe_id UUID REFERENCES saved_recipes(id) ON DELETE CASCADE,
  added_at TIMESTAMP DEFAULT NOW(),
  sort_order INTEGER DEFAULT 0,
  PRIMARY KEY (collection_id, recipe_id)
);

-- API call cache to reduce costs
CREATE TABLE IF NOT EXISTS instagram_cache (
  url TEXT PRIMARY KEY,
  data JSONB NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  expires_at TIMESTAMP DEFAULT NOW() + INTERVAL '30 days'
);

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_saved_recipes_user_created ON saved_recipes(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_saved_recipes_favorite ON saved_recipes(user_id, is_favorite, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_saved_recipes_source ON saved_recipes(source_type, source_url);
CREATE INDEX IF NOT EXISTS idx_shortcut_tokens_token ON shortcut_tokens(token) WHERE is_active = true;
CREATE INDEX IF NOT EXISTS idx_shortcut_tokens_user ON shortcut_tokens(user_id) WHERE is_active = true;
CREATE INDEX IF NOT EXISTS idx_instagram_cache_expires ON instagram_cache(expires_at);
CREATE INDEX IF NOT EXISTS idx_recipe_collections_user ON recipe_collections(user_id);
CREATE INDEX IF NOT EXISTS idx_recipe_collection_items_collection ON recipe_collection_items(collection_id);
CREATE INDEX IF NOT EXISTS idx_recipe_collection_items_recipe ON recipe_collection_items(recipe_id);

-- Enable Row Level Security
ALTER TABLE saved_recipes ENABLE ROW LEVEL SECURITY;
ALTER TABLE shortcut_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE recipe_collections ENABLE ROW LEVEL SECURITY;
ALTER TABLE recipe_collection_items ENABLE ROW LEVEL SECURITY;

-- RLS Policies for saved_recipes
CREATE POLICY "Users can view own recipes" ON saved_recipes
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can create own recipes" ON saved_recipes
  FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own recipes" ON saved_recipes
  FOR UPDATE USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own recipes" ON saved_recipes
  FOR DELETE USING (auth.uid() = user_id);

-- RLS Policies for shortcut_tokens
CREATE POLICY "Users can view own tokens" ON shortcut_tokens
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can create own tokens" ON shortcut_tokens
  FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own tokens" ON shortcut_tokens
  FOR UPDATE USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own tokens" ON shortcut_tokens
  FOR DELETE USING (auth.uid() = user_id);

-- RLS Policies for recipe_collections
CREATE POLICY "Users can view own collections" ON recipe_collections
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can create own collections" ON recipe_collections
  FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own collections" ON recipe_collections
  FOR UPDATE USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own collections" ON recipe_collections
  FOR DELETE USING (auth.uid() = user_id);

-- RLS Policies for recipe_collection_items (need to check via collection ownership)
CREATE POLICY "Users can view own collection items" ON recipe_collection_items
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM recipe_collections 
      WHERE recipe_collections.id = recipe_collection_items.collection_id 
      AND recipe_collections.user_id = auth.uid()
    )
  );

CREATE POLICY "Users can add to own collections" ON recipe_collection_items
  FOR INSERT WITH CHECK (
    EXISTS (
      SELECT 1 FROM recipe_collections 
      WHERE recipe_collections.id = recipe_collection_items.collection_id 
      AND recipe_collections.user_id = auth.uid()
    )
  );

CREATE POLICY "Users can remove from own collections" ON recipe_collection_items
  FOR DELETE USING (
    EXISTS (
      SELECT 1 FROM recipe_collections 
      WHERE recipe_collections.id = recipe_collection_items.collection_id 
      AND recipe_collections.user_id = auth.uid()
    )
  );

-- Function to update recipe_count in collections
CREATE OR REPLACE FUNCTION update_collection_recipe_count()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE recipe_collections 
    SET recipe_count = recipe_count + 1,
        updated_at = NOW()
    WHERE id = NEW.collection_id;
  ELSIF TG_OP = 'DELETE' THEN
    UPDATE recipe_collections 
    SET recipe_count = recipe_count - 1,
        updated_at = NOW()
    WHERE id = OLD.collection_id;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- Trigger to automatically update collection recipe count
CREATE TRIGGER update_collection_count
AFTER INSERT OR DELETE ON recipe_collection_items
FOR EACH ROW EXECUTE FUNCTION update_collection_recipe_count();

-- Function to clean expired cache entries
CREATE OR REPLACE FUNCTION clean_expired_cache()
RETURNS void AS $$
BEGIN
  DELETE FROM instagram_cache WHERE expires_at < NOW();
END;
$$ LANGUAGE plpgsql;

-- Optional: Schedule periodic cache cleanup (requires pg_cron extension)
-- SELECT cron.schedule('clean-instagram-cache', '0 2 * * *', 'SELECT clean_expired_cache();');