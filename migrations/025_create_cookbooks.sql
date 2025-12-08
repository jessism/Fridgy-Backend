-- Migration: Create Cookbooks Feature
-- Date: 2025-12-07
-- Description: Creates tables for cookbook collections to organize recipes
-- Note: RLS is disabled because the app uses custom JWT auth (not Supabase Auth).
--       Authorization is handled in the backend controller.

-- =====================================================
-- 1. Create cookbooks table
-- =====================================================
CREATE TABLE IF NOT EXISTS cookbooks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name VARCHAR(100) NOT NULL,
  description TEXT,
  cover_image TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- =====================================================
-- 2. Create cookbook_recipes junction table
-- =====================================================
CREATE TABLE IF NOT EXISTS cookbook_recipes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cookbook_id UUID NOT NULL REFERENCES cookbooks(id) ON DELETE CASCADE,
  recipe_id UUID NOT NULL,
  recipe_source VARCHAR(50) NOT NULL DEFAULT 'saved', -- 'saved', 'uploaded', 'ai_generated'
  added_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  position INTEGER DEFAULT 0,
  UNIQUE(cookbook_id, recipe_id, recipe_source)
);

-- =====================================================
-- 3. Create indexes for performance
-- =====================================================
CREATE INDEX IF NOT EXISTS idx_cookbooks_user_id ON cookbooks(user_id);
CREATE INDEX IF NOT EXISTS idx_cookbook_recipes_cookbook_id ON cookbook_recipes(cookbook_id);
CREATE INDEX IF NOT EXISTS idx_cookbook_recipes_recipe_id ON cookbook_recipes(recipe_id);

-- =====================================================
-- 4. Create updated_at trigger function (if not exists)
-- =====================================================
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- =====================================================
-- 5. Add trigger to auto-update updated_at
-- =====================================================
DROP TRIGGER IF EXISTS update_cookbooks_updated_at ON cookbooks;
CREATE TRIGGER update_cookbooks_updated_at
  BEFORE UPDATE ON cookbooks
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();
