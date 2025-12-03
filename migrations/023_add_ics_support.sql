-- Migration: Add ICS Calendar Subscription Support
-- Extends calendar connections to support Apple/Outlook via ICS subscription

-- Add subscription_token column for ICS provider
-- This token is used in the public ICS feed URL
ALTER TABLE user_calendar_connections
ADD COLUMN IF NOT EXISTS subscription_token VARCHAR(64) UNIQUE;

-- Make access_token and refresh_token nullable for ICS provider
-- (ICS doesn't use OAuth, only needs the subscription_token)
ALTER TABLE user_calendar_connections
ALTER COLUMN access_token DROP NOT NULL;

ALTER TABLE user_calendar_connections
ALTER COLUMN refresh_token DROP NOT NULL;

-- Add last_accessed tracking for ICS feeds (for security monitoring)
ALTER TABLE user_calendar_connections
ADD COLUMN IF NOT EXISTS last_accessed_at TIMESTAMP WITH TIME ZONE;

ALTER TABLE user_calendar_connections
ADD COLUMN IF NOT EXISTS access_count INTEGER DEFAULT 0;

-- Index for fast token lookups (public ICS endpoint)
CREATE INDEX IF NOT EXISTS idx_calendar_token ON user_calendar_connections(subscription_token)
WHERE subscription_token IS NOT NULL;

-- Comment on new columns
COMMENT ON COLUMN user_calendar_connections.subscription_token IS 'Unique token for ICS feed URL (provider=ics)';
COMMENT ON COLUMN user_calendar_connections.last_accessed_at IS 'Last time ICS feed was accessed';
COMMENT ON COLUMN user_calendar_connections.access_count IS 'Number of times ICS feed was accessed';
