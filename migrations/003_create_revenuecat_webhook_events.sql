-- Migration: Create RevenueCat webhook events table
-- Purpose: Track all RevenueCat webhook events for idempotency, debugging, and auditing
-- Date: February 20, 2026

CREATE TABLE IF NOT EXISTS revenuecat_webhook_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id TEXT UNIQUE NOT NULL,
  event_type TEXT NOT NULL,
  app_user_id TEXT,
  product_id TEXT,
  payload JSONB NOT NULL,
  processed BOOLEAN DEFAULT FALSE,
  processed_at TIMESTAMP,
  error_message TEXT,
  processing_attempts INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Index for fast idempotency checks
CREATE INDEX idx_revenuecat_events_event_id ON revenuecat_webhook_events(event_id);

-- Index for debugging failed events
CREATE INDEX idx_revenuecat_events_processed ON revenuecat_webhook_events(processed, created_at);

-- Index for user lookups
CREATE INDEX idx_revenuecat_events_app_user_id ON revenuecat_webhook_events(app_user_id);

-- Grandfather all existing test users (lifetime premium access)
-- These are all test users and should keep premium forever
UPDATE users
SET is_grandfathered = TRUE
WHERE created_at < NOW();

-- Verify grandfathered users
SELECT COUNT(*) as grandfathered_users
FROM users
WHERE is_grandfathered = TRUE;
