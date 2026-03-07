-- ============================================
-- Grant Permanent Premium Access to User
-- Run this in Supabase SQL Editor
-- ============================================

-- Update user to permanent premium (grandfathered)
-- This gives lifetime premium access
UPDATE users
SET
  tier = 'grandfathered',
  is_grandfathered = true,
  updated_at = NOW()
WHERE email = 'testa@gmail.com';

-- Verify the update
SELECT
  email,
  tier,
  is_grandfathered,
  updated_at,
  CASE
    WHEN tier = 'grandfathered' AND is_grandfathered = true THEN '✅ PERMANENT PREMIUM ACCESS GRANTED'
    WHEN tier = 'premium' THEN '⚠️ Premium but not grandfathered (will check subscription status)'
    ELSE '❌ Still on free tier'
  END as status
FROM users
WHERE email = 'testa@gmail.com';
