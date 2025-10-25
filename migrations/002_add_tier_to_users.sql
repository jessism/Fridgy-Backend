-- Migration 002: Add tier tracking to users table
-- Description: Adds tier and grandfathering columns to users table for quick access to subscription status
-- Date: January 2025

-- Add tier column
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS tier VARCHAR(50) DEFAULT 'free' CHECK (tier IN ('free', 'premium', 'grandfathered'));

-- Add grandfathering flag
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS is_grandfathered BOOLEAN DEFAULT false;

-- Add comments
COMMENT ON COLUMN users.tier IS 'User subscription tier: free, premium, or grandfathered (lifetime premium)';
COMMENT ON COLUMN users.is_grandfathered IS 'If true, user gets lifetime premium access (early adopter reward)';

-- Create index for tier lookups
CREATE INDEX IF NOT EXISTS idx_users_tier ON users(tier);
CREATE INDEX IF NOT EXISTS idx_users_grandfathered ON users(is_grandfathered) WHERE is_grandfathered = true;

-- Set default tier for all existing users
UPDATE users SET tier = 'free' WHERE tier IS NULL;

COMMENT ON TABLE users IS 'Migration 002 completed: tier tracking added';
