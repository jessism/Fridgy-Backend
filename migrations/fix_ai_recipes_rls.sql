-- Fix RLS policies for AI Recipe tables to work with custom JWT auth
-- Run this to fix the Row Level Security issues

-- Drop existing policies
DROP POLICY IF EXISTS "Users can view own generated recipes" ON ai_generated_recipes;
DROP POLICY IF EXISTS "Users can insert own generated recipes" ON ai_generated_recipes;
DROP POLICY IF EXISTS "Users can update own generated recipes" ON ai_generated_recipes;
DROP POLICY IF EXISTS "Users can delete own generated recipes" ON ai_generated_recipes;

DROP POLICY IF EXISTS "Anyone can view recipe images" ON ai_recipe_images;
DROP POLICY IF EXISTS "Authenticated users can insert recipe images" ON ai_recipe_images;

DROP POLICY IF EXISTS "Users can view own analytics" ON ai_recipe_analytics;
DROP POLICY IF EXISTS "Users can insert own analytics" ON ai_recipe_analytics;

-- Disable RLS for now since we're using custom JWT auth (not Supabase Auth)
-- We'll handle authorization in our backend controllers
ALTER TABLE ai_generated_recipes DISABLE ROW LEVEL SECURITY;
ALTER TABLE ai_recipe_images DISABLE ROW LEVEL SECURITY;
ALTER TABLE ai_recipe_analytics DISABLE ROW LEVEL SECURITY;

-- Grant full access to authenticated users (backend will handle auth)
GRANT ALL ON ai_generated_recipes TO anon, authenticated;
GRANT ALL ON ai_recipe_images TO anon, authenticated;  
GRANT ALL ON ai_recipe_analytics TO anon, authenticated;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO anon, authenticated;