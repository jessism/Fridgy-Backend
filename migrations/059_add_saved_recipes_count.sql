-- Add saved_recipes_count column to usage_limits table
-- Migration: 059 - Saved Recipes Weekly Limit
-- Date: 2026-04-03
-- Purpose: Add unified weekly recipe save counter (5 recipes/week for free tier)

-- Add the new column to track ALL recipe saves (imported, uploaded, manual, etc.)
ALTER TABLE usage_limits
ADD COLUMN IF NOT EXISTS saved_recipes_count INTEGER DEFAULT 0;

-- Add comment for documentation
COMMENT ON COLUMN usage_limits.saved_recipes_count IS 'Total number of recipes saved this week (all sources: imported, uploaded, manual). Free tier: 5/week. Resets every 7 days.';

-- Add index for faster queries
CREATE INDEX IF NOT EXISTS idx_usage_limits_saved_recipes ON usage_limits(saved_recipes_count);

-- Note: The existing imported_recipes_count and uploaded_recipes_count columns
-- are kept for backwards compatibility but are now deprecated.
-- All new recipe saves should increment saved_recipes_count.
