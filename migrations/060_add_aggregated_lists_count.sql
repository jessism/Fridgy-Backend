-- Add aggregated_shopping_lists_count column to usage_limits table
-- Migration: 060 - Meal Plan Aggregated Shopping List Weekly Limit
-- Date: 2026-04-03
-- Purpose: Add weekly limit for aggregated shopping lists from meal plan (1/week for free tier)

-- Add the new column to track aggregated shopping list creation from meal plan
ALTER TABLE usage_limits
ADD COLUMN IF NOT EXISTS aggregated_shopping_lists_count INTEGER DEFAULT 0;

-- Add comment for documentation
COMMENT ON COLUMN usage_limits.aggregated_shopping_lists_count IS 'Number of aggregated shopping lists created from meal plan this week. Free tier: 1/week, Premium: unlimited. Resets every 7 days.';

-- Add index for faster queries
CREATE INDEX IF NOT EXISTS idx_usage_limits_aggregated_lists ON usage_limits(aggregated_shopping_lists_count);

-- Note: This is separate from owned_shopping_lists_count.
-- Normal shopping list creation is unlimited for all users.
-- Only the aggregated meal plan lists are limited to 1/week for free tier.
