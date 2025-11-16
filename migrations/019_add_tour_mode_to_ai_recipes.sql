-- Migration: Add tour_mode column to ai_generated_recipes table
-- Purpose: Track which recipes were generated during welcome tour (demo mode)
-- This allows frontend to show "DEMO" badge instead of "AI Generated"

-- Add tour_mode column to ai_generated_recipes table
ALTER TABLE ai_generated_recipes
ADD COLUMN IF NOT EXISTS tour_mode BOOLEAN DEFAULT false;

-- Add comment to explain the column
COMMENT ON COLUMN ai_generated_recipes.tour_mode IS 'Indicates if recipes were generated during welcome tour with demo inventory';

-- Update existing records to have tour_mode = false (they are real recipes)
UPDATE ai_generated_recipes
SET tour_mode = false
WHERE tour_mode IS NULL;

-- Create index for faster filtering by tour_mode
CREATE INDEX IF NOT EXISTS idx_ai_generated_recipes_tour_mode ON ai_generated_recipes(tour_mode);

-- Verify the column was added successfully
-- SELECT column_name, data_type, column_default FROM information_schema.columns WHERE table_name = 'ai_generated_recipes' AND column_name = 'tour_mode';
