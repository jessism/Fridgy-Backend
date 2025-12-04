-- Migration: Fix meal_plans recipe_source constraint
-- Issue: The constraint only allows 'saved', 'ai', 'suggestion' but the app
-- also uses 'imported' and 'uploaded' source types from the RecipePickerModal

-- Drop the existing constraint
ALTER TABLE meal_plans
DROP CONSTRAINT IF EXISTS meal_plans_recipe_source_check;

-- Add the updated constraint with all valid source types
ALTER TABLE meal_plans
ADD CONSTRAINT meal_plans_recipe_source_check
CHECK (recipe_source IN ('saved', 'ai', 'suggestion', 'imported', 'uploaded'));
