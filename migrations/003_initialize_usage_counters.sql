-- Migration 003: Initialize usage counters with actual current usage
-- Description: Calculates and sets current usage counts for all users based on existing data
-- Date: January 2025
-- IMPORTANT: Run this after migrations 001 and 002

-- =====================================================
-- STEP 1: Ensure all users have usage_limits entry
-- =====================================================
INSERT INTO usage_limits (user_id)
SELECT id FROM users
WHERE id NOT IN (SELECT user_id FROM usage_limits);

-- =====================================================
-- STEP 2: Calculate actual usage counts from existing data
-- =====================================================

-- Update grocery_items_count
UPDATE usage_limits ul
SET grocery_items_count = (
  SELECT COUNT(*)
  FROM fridge_items
  WHERE user_id::text = ul.user_id::text
);

-- Update imported_recipes_count (recipes from Instagram)
UPDATE usage_limits ul
SET imported_recipes_count = (
  SELECT COUNT(*)
  FROM saved_recipes
  WHERE user_id::text = ul.user_id::text
  AND source_type = 'instagram'
);

-- Update uploaded_recipes_count (manually created recipes)
UPDATE usage_limits ul
SET uploaded_recipes_count = (
  SELECT COUNT(*)
  FROM saved_recipes
  WHERE user_id::text = ul.user_id::text
  AND (source_type = 'manual' OR source_type IS NULL)
);

-- Update meal_logs_count
UPDATE usage_limits ul
SET meal_logs_count = (
  SELECT COUNT(*)
  FROM meal_logs
  WHERE user_id::text = ul.user_id::text
);

-- Update owned_shopping_lists_count
UPDATE usage_limits ul
SET owned_shopping_lists_count = (
  SELECT COUNT(*)
  FROM shopping_lists
  WHERE owner_id::text = ul.user_id::text
);

-- Update joined_shopping_lists_count (lists user is member of but doesn't own)
UPDATE usage_limits ul
SET joined_shopping_lists_count = (
  SELECT COUNT(DISTINCT slm.list_id)
  FROM shopping_list_members slm
  WHERE slm.user_id::text = ul.user_id::text
  AND slm.list_id NOT IN (
    SELECT id FROM shopping_lists WHERE owner_id::text = ul.user_id::text
  )
);

-- Set last_reset_at to now
UPDATE usage_limits SET last_reset_at = NOW();

-- =====================================================
-- STEP 3: Create view for monitoring usage
-- =====================================================
CREATE OR REPLACE VIEW v_user_usage_summary AS
SELECT
  u.id AS user_id,
  u.email,
  u.first_name,
  u.tier,
  u.is_grandfathered,
  s.status AS subscription_status,
  s.trial_end,
  s.current_period_end,
  ul.grocery_items_count,
  ul.imported_recipes_count,
  ul.uploaded_recipes_count,
  ul.meal_logs_count,
  ul.owned_shopping_lists_count,
  ul.joined_shopping_lists_count,
  ul.ai_recipe_generations_count,
  ul.last_reset_at,
  u.created_at AS user_created_at
FROM users u
LEFT JOIN subscriptions s ON s.user_id = u.id
LEFT JOIN usage_limits ul ON ul.user_id = u.id
ORDER BY u.created_at DESC;

COMMENT ON VIEW v_user_usage_summary IS 'Convenient view for monitoring user subscriptions and usage';

-- =====================================================
-- VERIFICATION QUERIES (for manual checking)
-- =====================================================
-- Uncomment these to verify migration succeeded:

-- Check users without usage_limits entries
-- SELECT COUNT(*) FROM users WHERE id NOT IN (SELECT user_id FROM usage_limits);
-- Expected: 0

-- Check usage count accuracy
-- SELECT
--   u.email,
--   ul.grocery_items_count AS counted,
--   (SELECT COUNT(*) FROM fridge_items WHERE user_id = u.id) AS actual
-- FROM users u
-- JOIN usage_limits ul ON ul.user_id = u.id
-- WHERE ul.grocery_items_count != (SELECT COUNT(*) FROM fridge_items WHERE user_id = u.id);
-- Expected: 0 rows (all counts should match)

COMMENT ON TABLE usage_limits IS 'Migration 003 completed: usage counters initialized';
