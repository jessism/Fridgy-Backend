-- Migration: Enhanced tour status tracking
-- Purpose: Add granular status tracking to distinguish between started, completed, and skipped tours
-- Created: 2025-11-15
-- Replaces simple boolean flag with enum-based status system

-- Add tour status enum column
ALTER TABLE users
ADD COLUMN IF NOT EXISTS tour_status VARCHAR(20) DEFAULT 'not_started'
  CHECK (tour_status IN ('not_started', 'in_progress', 'completed', 'skipped'));

-- Add timestamp tracking columns
ALTER TABLE users
ADD COLUMN IF NOT EXISTS tour_started_at TIMESTAMP;

ALTER TABLE users
ADD COLUMN IF NOT EXISTS tour_completed_at TIMESTAMP;

ALTER TABLE users
ADD COLUMN IF NOT EXISTS tour_abandoned_at TIMESTAMP;

-- Add final step tracking (shows where user reached or quit)
ALTER TABLE users
ADD COLUMN IF NOT EXISTS tour_final_step VARCHAR(100);

-- Create index for faster tour status queries (analytics)
CREATE INDEX IF NOT EXISTS idx_users_tour_status ON users(tour_status);

-- Create index for completion time analytics
CREATE INDEX IF NOT EXISTS idx_users_tour_completed_at ON users(tour_completed_at)
  WHERE tour_completed_at IS NOT NULL;

-- Migration path for existing users
-- Convert existing has_seen_welcome_tour boolean to new status system
UPDATE users
SET tour_status = CASE
  WHEN has_seen_welcome_tour = true THEN 'completed'
  ELSE 'not_started'
END,
tour_completed_at = CASE
  WHEN has_seen_welcome_tour = true THEN created_at + INTERVAL '1 day'
  ELSE NULL
END
WHERE tour_status IS NULL OR tour_status = 'not_started';

-- Note: We keep has_seen_welcome_tour column for backwards compatibility
-- Plan to deprecate in future version once all clients updated

-- Add comment to deprecated column
COMMENT ON COLUMN users.has_seen_welcome_tour IS 'DEPRECATED: Use tour_status instead. Kept for backwards compatibility.';

-- Add comments for new columns
COMMENT ON COLUMN users.tour_status IS 'Current tour status: not_started, in_progress, completed, or skipped';
COMMENT ON COLUMN users.tour_started_at IS 'Timestamp when user first started the welcome tour';
COMMENT ON COLUMN users.tour_completed_at IS 'Timestamp when user completed the welcome tour';
COMMENT ON COLUMN users.tour_abandoned_at IS 'Timestamp when user skipped/dismissed the welcome tour';
COMMENT ON COLUMN users.tour_final_step IS 'Last step user reached (for analytics on abandon points)';
