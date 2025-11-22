-- ============================================
-- Check Subscription Status for hello@trackabite.app
-- Run this in Supabase SQL Editor
-- ============================================

-- Get complete subscription information
SELECT
  -- User Info
  u.email,
  u.first_name,
  u.tier as user_tier,
  u.is_grandfathered,

  -- Subscription Details
  s.id as subscription_id,
  s.tier as subscription_tier,
  s.status,
  s.stripe_customer_id,
  s.stripe_subscription_id,

  -- Trial Information
  s.trial_start,
  s.trial_end,
  s.trial_end > NOW() as trial_still_active,

  -- Billing Period
  s.current_period_start,
  s.current_period_end,

  -- Cancellation Status
  s.cancel_at_period_end,
  s.canceled_at,

  -- Timestamps
  s.created_at as subscription_created,
  s.updated_at as subscription_updated,

  -- Interpretation
  CASE
    WHEN s.cancel_at_period_end = true AND s.status = 'trialing' THEN
      'CANCELED - User still has Pro access until trial ends on ' || s.trial_end::date
    WHEN s.cancel_at_period_end = true AND s.status = 'active' THEN
      'CANCELED - User still has Pro access until ' || s.current_period_end::date
    WHEN s.status = 'trialing' THEN
      'ACTIVE TRIAL - Will convert to paid on ' || s.trial_end::date
    WHEN s.status = 'active' THEN
      'ACTIVE SUBSCRIPTION - Renews on ' || s.current_period_end::date
    WHEN s.status = 'canceled' THEN
      'FULLY CANCELED - No access'
    ELSE
      'OTHER STATUS: ' || s.status
  END as status_summary

FROM users u
LEFT JOIN subscriptions s ON u.id = s.user_id
WHERE u.email = 'hello@trackabite.app';


-- ============================================
-- Quick Status Check (One Line Summary)
-- ============================================

SELECT
  u.email,
  u.tier,
  s.status,
  s.cancel_at_period_end,
  CASE
    WHEN s.cancel_at_period_end THEN 'YES (Canceled)'
    ELSE 'NO (Active)'
  END as is_canceled,
  COALESCE(s.trial_end, s.current_period_end)::date as access_until,
  CASE
    WHEN COALESCE(s.trial_end, s.current_period_end) > NOW() THEN 'YES'
    ELSE 'NO'
  END as has_access_now
FROM users u
LEFT JOIN subscriptions s ON u.id = s.user_id
WHERE u.email = 'hello@trackabite.app';


-- ============================================
-- Check Usage Limits (to see what they've used)
-- ============================================

SELECT
  u.email,
  ul.grocery_items_count,
  ul.imported_recipes_count,
  ul.uploaded_recipes_count,
  ul.meal_logs_count,
  ul.owned_shopping_lists_count,
  ul.ai_recipe_generations_count,
  ul.last_reset_at
FROM users u
LEFT JOIN usage_limits ul ON u.id = ul.user_id
WHERE u.email = 'hello@trackabite.app';
