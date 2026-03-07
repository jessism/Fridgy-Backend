-- Migration 004: Add account deletion tracking to users table
-- Description: Adds columns to track account deletion requests with 30-day grace period
-- Date: February 22, 2026

-- Add deletion tracking columns
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS deletion_requested_at TIMESTAMP,
  ADD COLUMN IF NOT EXISTS deletion_scheduled_for TIMESTAMP,
  ADD COLUMN IF NOT EXISTS deletion_status VARCHAR(20) DEFAULT NULL CHECK (deletion_status IN (NULL, 'pending', 'cancelled', 'completed'));

-- Add comments
COMMENT ON COLUMN users.deletion_requested_at IS 'Timestamp when user requested account deletion';
COMMENT ON COLUMN users.deletion_scheduled_for IS 'Date when account will be permanently deleted (30 days after request)';
COMMENT ON COLUMN users.deletion_status IS 'Status of deletion: NULL (no request), pending (waiting for grace period), cancelled (user revoked), completed (deleted)';

-- Create index for finding accounts ready for deletion
CREATE INDEX IF NOT EXISTS idx_users_deletion_scheduled
  ON users(deletion_scheduled_for)
  WHERE deletion_status = 'pending' AND deletion_scheduled_for IS NOT NULL;

COMMENT ON TABLE users IS 'Migration 004 completed: account deletion tracking added';
