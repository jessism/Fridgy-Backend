-- Add tags column to saved_recipes table
-- Migration: 058 - Recipe Tags Feature
-- Date: 2026-03-29
-- Purpose: Enable AI-generated and custom tagging for recipes

ALTER TABLE saved_recipes
ADD COLUMN IF NOT EXISTS tags JSONB DEFAULT '[]'::jsonb;

-- Add GIN index for fast tag filtering queries
CREATE INDEX IF NOT EXISTS idx_saved_recipes_tags ON saved_recipes USING GIN (tags);

-- Add comment for documentation
COMMENT ON COLUMN saved_recipes.tags IS 'Array of tag objects with id, name, category, and is_custom fields. Example: [{"id": "tag_vegetarian", "name": "Vegetarian", "category": "dietary", "is_custom": false}]';

-- Example tag structure for reference:
-- [
--   {"id": "tag_vegetarian", "name": "Vegetarian", "category": "dietary", "is_custom": false},
--   {"id": "tag_vegan", "name": "Vegan", "category": "dietary", "is_custom": false},
--   {"id": "tag_quick", "name": "Quick", "category": "speed", "is_custom": false},
--   {"id": "custom_spicy", "name": "Spicy", "category": "custom", "is_custom": true}
-- ]

-- Tag categories:
-- - dietary: Vegetarian, Vegan, Keto, Paleo, Gluten-Free, Dairy-Free, Low Carb, High Protein
-- - meal_type: Breakfast, Lunch, Dinner, Snack, Dessert, Appetizer
-- - speed: Quick (< 30 min), Easy
-- - protein: Chicken, Beef, Seafood, Pork, Plant-Based
-- - cuisine: Italian, Mexican, Asian, Mediterranean, American, Indian, French, Thai
-- - occasion: Weeknight, Weekend, Meal Prep, Party, Holiday
-- - custom: User-defined tags
