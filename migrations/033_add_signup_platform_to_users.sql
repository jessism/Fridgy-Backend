-- Migration 033: Add signup platform tracking to users table
-- Description: Track which platform (mobile/web) user signed up from to send platform-specific welcome email links
-- Date: March 15, 2026

-- Add signup_platform column
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS signup_platform VARCHAR(20) DEFAULT 'web'
    CHECK (signup_platform IN ('mobile', 'web'));

-- Add comment for documentation
COMMENT ON COLUMN users.signup_platform IS 'Platform where user signed up: mobile or web. Used to send platform-specific welcome email links.';

-- Create index for analytics/reporting
CREATE INDEX IF NOT EXISTS idx_users_signup_platform ON users(signup_platform);

-- Set default platform for all existing users
UPDATE users SET signup_platform = 'web' WHERE signup_platform IS NULL;

-- Migration completion marker
COMMENT ON TABLE users IS 'Migration 033 completed: signup platform tracking added';
