-- Migration: Refactor tour tracking to separate table
-- Purpose: Move tour tracking from users table to dedicated user_tours table
-- Created: 2025-11-15
-- This provides better flexibility for multiple tours and easier extensibility

-- ============================================
-- STEP 1: Rollback columns added in migration 017
-- ============================================

-- Drop indexes first
DROP INDEX IF EXISTS idx_users_tour_status;
DROP INDEX IF EXISTS idx_users_tour_completed_at;

-- Remove columns added in migration 017
ALTER TABLE users DROP COLUMN IF EXISTS tour_status;
ALTER TABLE users DROP COLUMN IF EXISTS tour_started_at;
ALTER TABLE users DROP COLUMN IF EXISTS tour_completed_at;
ALTER TABLE users DROP COLUMN IF EXISTS tour_abandoned_at;
ALTER TABLE users DROP COLUMN IF EXISTS tour_final_step;

-- ============================================
-- STEP 2: Create new user_tours table
-- ============================================

CREATE TABLE IF NOT EXISTS user_tours (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  -- Tour identification
  tour_type VARCHAR(50) NOT NULL DEFAULT 'welcome',  -- 'welcome', 'feature_discovery', etc.
  tour_version VARCHAR(20) DEFAULT '1.0',            -- For A/B testing different tour versions

  -- Tour status tracking
  status VARCHAR(20) NOT NULL DEFAULT 'not_started'
    CHECK (status IN ('not_started', 'in_progress', 'completed', 'skipped')),

  -- Timestamps
  started_at TIMESTAMP,
  completed_at TIMESTAMP,
  abandoned_at TIMESTAMP,

  -- Progress tracking
  final_step VARCHAR(100),           -- Last step user reached
  total_steps INTEGER,                -- Total steps in this tour version
  completed_steps INTEGER DEFAULT 0,  -- How many steps user completed

  -- Metadata
  source VARCHAR(50),                 -- 'auto', 'manual', 'replay'
  skip_reason VARCHAR(50),            -- 'user_action', 'navigation', 'timeout'

  -- Standard timestamps
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- ============================================
-- STEP 3: Create indexes for performance
-- ============================================

-- Index for finding user's tour status (most common query)
CREATE INDEX idx_user_tours_user_id_tour_type ON user_tours(user_id, tour_type);

-- Index for analytics queries
CREATE INDEX idx_user_tours_status ON user_tours(status);
CREATE INDEX idx_user_tours_tour_type_status ON user_tours(tour_type, status);

-- Index for completion time analytics
CREATE INDEX idx_user_tours_completed_at ON user_tours(completed_at)
  WHERE completed_at IS NOT NULL;

-- ============================================
-- STEP 4: Migrate existing data
-- ============================================

-- For users who have completed the welcome tour (has_seen_welcome_tour = true)
-- Create a 'completed' tour record
INSERT INTO user_tours (user_id, tour_type, status, completed_at, created_at)
SELECT
  id as user_id,
  'welcome' as tour_type,
  'completed' as status,
  created_at + INTERVAL '1 day' as completed_at,  -- Estimate completion time
  created_at
FROM users
WHERE has_seen_welcome_tour = true
ON CONFLICT DO NOTHING;

-- Note: Users with has_seen_welcome_tour = false will get tour on next login
-- (no record in user_tours table = show tour)

-- ============================================
-- STEP 5: Add helpful comments
-- ============================================

COMMENT ON TABLE user_tours IS 'Tracks user progress through various onboarding tours and feature discovery flows';
COMMENT ON COLUMN user_tours.tour_type IS 'Type of tour: welcome, feature_discovery, etc. Allows multiple tour types per user';
COMMENT ON COLUMN user_tours.tour_version IS 'Version of the tour for A/B testing. Format: 1.0, 1.1, 2.0';
COMMENT ON COLUMN user_tours.status IS 'Current status: not_started, in_progress, completed, or skipped';
COMMENT ON COLUMN user_tours.final_step IS 'Last step user reached - useful for analyzing abandon points';
COMMENT ON COLUMN user_tours.completed_steps IS 'Number of steps completed out of total_steps';
COMMENT ON COLUMN user_tours.source IS 'How tour was initiated: auto (first login), manual (help menu), replay';
COMMENT ON COLUMN user_tours.skip_reason IS 'Why user skipped: user_action, navigation, timeout';

-- Keep has_seen_welcome_tour for backwards compatibility (for now)
COMMENT ON COLUMN users.has_seen_welcome_tour IS 'DEPRECATED: Check user_tours table instead. Kept for backwards compatibility during migration.';
