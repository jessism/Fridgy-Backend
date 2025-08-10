-- AI Recipe Recommendation System Database Schema
-- Run this after the existing user_dietary_preferences table is created

-- Cache AI-generated recipes with 24-hour expiration
CREATE TABLE IF NOT EXISTS ai_generated_recipes (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content_hash VARCHAR(64) UNIQUE NOT NULL, -- Hash of inventory + preferences + date
  recipes JSONB NOT NULL, -- Store 3 recipes with complete metadata
  image_urls TEXT[] DEFAULT '{}', -- Array of generated image URLs
  generation_status VARCHAR(20) DEFAULT 'pending', -- pending, generating, completed, failed
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  expires_at TIMESTAMP WITH TIME ZONE DEFAULT NOW() + INTERVAL '24 hours',
  last_accessed TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Cache individual recipe images to avoid regenerating same dishes
CREATE TABLE IF NOT EXISTS ai_recipe_images (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  recipe_hash VARCHAR(64) UNIQUE NOT NULL, -- Hash of recipe title + key ingredients
  image_url TEXT NOT NULL,
  prompt_used TEXT NOT NULL,
  fireworks_image_id TEXT, -- Store Fireworks AI image ID for reference
  generation_cost DECIMAL(8,6) DEFAULT 0.005, -- Track costs for analytics
  quality_score INTEGER DEFAULT 5, -- 1-10 quality rating for future optimization
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Track AI recipe generation analytics for optimization
CREATE TABLE IF NOT EXISTS ai_recipe_analytics (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  generation_time_ms INTEGER, -- Track generation performance
  recipe_count INTEGER DEFAULT 3,
  cache_hit BOOLEAN DEFAULT FALSE,
  total_cost DECIMAL(8,6),
  error_type VARCHAR(50), -- Track common errors for improvement
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_ai_generated_recipes_user_id ON ai_generated_recipes(user_id);
CREATE INDEX IF NOT EXISTS idx_ai_generated_recipes_content_hash ON ai_generated_recipes(content_hash);
CREATE INDEX IF NOT EXISTS idx_ai_generated_recipes_expires_at ON ai_generated_recipes(expires_at);
CREATE INDEX IF NOT EXISTS idx_ai_recipe_images_recipe_hash ON ai_recipe_images(recipe_hash);
CREATE INDEX IF NOT EXISTS idx_ai_recipe_analytics_user_id ON ai_recipe_analytics(user_id, created_at);

-- Enable Row Level Security
ALTER TABLE ai_generated_recipes ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_recipe_images ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_recipe_analytics ENABLE ROW LEVEL SECURITY;

-- RLS Policies for ai_generated_recipes
CREATE POLICY "Users can view own generated recipes" ON ai_generated_recipes
  FOR SELECT USING (user_id = auth.uid() OR user_id IN (
    SELECT id FROM users WHERE id = auth.uid()
  ));

CREATE POLICY "Users can insert own generated recipes" ON ai_generated_recipes
  FOR INSERT WITH CHECK (user_id = auth.uid() OR user_id IN (
    SELECT id FROM users WHERE id = auth.uid()
  ));

CREATE POLICY "Users can update own generated recipes" ON ai_generated_recipes
  FOR UPDATE USING (user_id = auth.uid() OR user_id IN (
    SELECT id FROM users WHERE id = auth.uid()
  ));

CREATE POLICY "Users can delete own generated recipes" ON ai_generated_recipes
  FOR DELETE USING (user_id = auth.uid() OR user_id IN (
    SELECT id FROM users WHERE id = auth.uid()
  ));

-- RLS Policies for ai_recipe_images (public read, authenticated insert)
CREATE POLICY "Anyone can view recipe images" ON ai_recipe_images
  FOR SELECT USING (true);

CREATE POLICY "Authenticated users can insert recipe images" ON ai_recipe_images
  FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);

-- RLS Policies for ai_recipe_analytics
CREATE POLICY "Users can view own analytics" ON ai_recipe_analytics
  FOR SELECT USING (user_id = auth.uid() OR user_id IN (
    SELECT id FROM users WHERE id = auth.uid()
  ));

CREATE POLICY "Users can insert own analytics" ON ai_recipe_analytics
  FOR INSERT WITH CHECK (user_id = auth.uid() OR user_id IN (
    SELECT id FROM users WHERE id = auth.uid()
  ));

-- Grant necessary permissions
GRANT ALL ON ai_generated_recipes TO anon, authenticated;
GRANT ALL ON ai_recipe_images TO anon, authenticated;  
GRANT ALL ON ai_recipe_analytics TO anon, authenticated;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO anon, authenticated;

-- Create function to automatically clean up expired recipes
CREATE OR REPLACE FUNCTION cleanup_expired_recipes()
RETURNS void AS $$
BEGIN
  DELETE FROM ai_generated_recipes WHERE expires_at < NOW();
END;
$$ LANGUAGE plpgsql;

-- Create trigger to update last_accessed on SELECT
CREATE OR REPLACE FUNCTION update_recipe_last_accessed()
RETURNS trigger AS $$
BEGIN
  NEW.last_accessed = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_ai_recipes_last_accessed
  BEFORE UPDATE ON ai_generated_recipes
  FOR EACH ROW
  EXECUTE FUNCTION update_recipe_last_accessed();