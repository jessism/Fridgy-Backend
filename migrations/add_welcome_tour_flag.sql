-- Migration: Add welcome tour completion flag to users table
-- Created: 2025-11-02
-- Purpose: Track if user has seen/completed the welcome tour for proper onboarding flow

-- Add column to users table
ALTER TABLE users
ADD COLUMN IF NOT EXISTS has_seen_welcome_tour BOOLEAN DEFAULT false;

-- Add comment for documentation
COMMENT ON COLUMN users.has_seen_welcome_tour IS 'Tracks whether user has completed or dismissed the welcome tour';

-- Set to false for all existing users (they can re-see the tour)
UPDATE users
SET has_seen_welcome_tour = false
WHERE has_seen_welcome_tour IS NULL;
