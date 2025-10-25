-- Migration 001: Create subscription-related tables
-- Description: Sets up core tables for Stripe subscription management, usage tracking, promo codes, and webhook logging
-- Date: January 2025

-- Enable UUID extension if not already enabled
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- =====================================================
-- SUBSCRIPTIONS TABLE
-- =====================================================
-- Stores subscription data synced from Stripe
CREATE TABLE IF NOT EXISTS subscriptions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID UNIQUE NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  stripe_customer_id VARCHAR(255) UNIQUE,
  stripe_subscription_id VARCHAR(255) UNIQUE,
  stripe_price_id VARCHAR(255),
  tier VARCHAR(50) DEFAULT 'free' CHECK (tier IN ('free', 'premium', 'grandfathered')),
  status VARCHAR(50) CHECK (status IN ('active', 'trialing', 'past_due', 'canceled', 'unpaid', 'incomplete')),
  trial_start TIMESTAMP,
  trial_end TIMESTAMP,
  current_period_start TIMESTAMP,
  current_period_end TIMESTAMP,
  cancel_at_period_end BOOLEAN DEFAULT false,
  canceled_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

COMMENT ON TABLE subscriptions IS 'Subscription data synced from Stripe webhooks';
COMMENT ON COLUMN subscriptions.tier IS 'User tier: free (default), premium (paid), or grandfathered (lifetime free premium)';
COMMENT ON COLUMN subscriptions.status IS 'Stripe subscription status: active, trialing, past_due, canceled, unpaid, incomplete';
COMMENT ON COLUMN subscriptions.cancel_at_period_end IS 'If true, subscription will cancel at current_period_end';

-- =====================================================
-- USAGE LIMITS TABLE
-- =====================================================
-- Tracks real-time usage counts for limit enforcement
CREATE TABLE IF NOT EXISTS usage_limits (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID UNIQUE NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  -- Feature usage counts
  grocery_items_count INT DEFAULT 0 CHECK (grocery_items_count >= 0),
  imported_recipes_count INT DEFAULT 0 CHECK (imported_recipes_count >= 0),
  uploaded_recipes_count INT DEFAULT 0 CHECK (uploaded_recipes_count >= 0),
  meal_logs_count INT DEFAULT 0 CHECK (meal_logs_count >= 0),
  owned_shopping_lists_count INT DEFAULT 0 CHECK (owned_shopping_lists_count >= 0),
  joined_shopping_lists_count INT DEFAULT 0 CHECK (joined_shopping_lists_count >= 0),
  ai_recipe_generations_count INT DEFAULT 0 CHECK (ai_recipe_generations_count >= 0),

  -- Metadata
  last_reset_at TIMESTAMP DEFAULT NOW(),
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

COMMENT ON TABLE usage_limits IS 'Real-time usage tracking for feature limit enforcement';
COMMENT ON COLUMN usage_limits.grocery_items_count IS 'Current count of inventory items (fridge_items table)';
COMMENT ON COLUMN usage_limits.imported_recipes_count IS 'Recipes imported from Instagram';
COMMENT ON COLUMN usage_limits.uploaded_recipes_count IS 'Manually created recipes';
COMMENT ON COLUMN usage_limits.meal_logs_count IS 'Number of logged meals';
COMMENT ON COLUMN usage_limits.owned_shopping_lists_count IS 'Shopping lists created by user';
COMMENT ON COLUMN usage_limits.joined_shopping_lists_count IS 'Shopping lists user joined via share code';

-- =====================================================
-- PROMO CODES TABLE
-- =====================================================
-- Manages discount codes synced with Stripe coupons
CREATE TABLE IF NOT EXISTS promo_codes (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  code VARCHAR(50) UNIQUE NOT NULL,
  stripe_coupon_id VARCHAR(255) UNIQUE,
  discount_type VARCHAR(20) CHECK (discount_type IN ('percent', 'fixed')),
  discount_value DECIMAL(10,2) CHECK (discount_value >= 0),
  duration VARCHAR(20) CHECK (duration IN ('once', 'repeating', 'forever')),
  duration_in_months INT CHECK (duration_in_months > 0),
  max_redemptions INT CHECK (max_redemptions > 0),
  times_redeemed INT DEFAULT 0 CHECK (times_redeemed >= 0),
  active BOOLEAN DEFAULT true,
  expires_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

COMMENT ON TABLE promo_codes IS 'Promotional discount codes synced with Stripe coupons';
COMMENT ON COLUMN promo_codes.duration IS 'once: one-time discount, repeating: multi-month discount, forever: permanent discount';
COMMENT ON COLUMN promo_codes.max_redemptions IS 'Maximum number of times code can be redeemed across all users';

-- =====================================================
-- USER PROMO CODES TABLE
-- =====================================================
-- Tracks which users have redeemed which promo codes
CREATE TABLE IF NOT EXISTS user_promo_codes (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  promo_code_id UUID NOT NULL REFERENCES promo_codes(id) ON DELETE CASCADE,
  stripe_subscription_id VARCHAR(255),
  redeemed_at TIMESTAMP DEFAULT NOW(),

  UNIQUE(user_id, promo_code_id)
);

COMMENT ON TABLE user_promo_codes IS 'Tracks promo code redemptions per user';

-- =====================================================
-- STRIPE WEBHOOK EVENTS TABLE
-- =====================================================
-- Logs all Stripe webhook events for debugging and idempotency
CREATE TABLE IF NOT EXISTS stripe_webhook_events (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  event_id VARCHAR(255) UNIQUE NOT NULL,
  event_type VARCHAR(100) NOT NULL,
  stripe_customer_id VARCHAR(255),
  payload JSONB NOT NULL,
  processed BOOLEAN DEFAULT false,
  error_message TEXT,
  processing_attempts INT DEFAULT 0 CHECK (processing_attempts >= 0),
  created_at TIMESTAMP DEFAULT NOW(),
  processed_at TIMESTAMP
);

COMMENT ON TABLE stripe_webhook_events IS 'Log of all Stripe webhook events for debugging and idempotency checks';
COMMENT ON COLUMN stripe_webhook_events.event_id IS 'Stripe event ID (e.g., evt_1234567890)';
COMMENT ON COLUMN stripe_webhook_events.processed IS 'Whether event has been successfully processed';

-- =====================================================
-- INDEXES
-- =====================================================
-- Subscriptions indexes
CREATE INDEX idx_subscriptions_user_id ON subscriptions(user_id);
CREATE INDEX idx_subscriptions_stripe_customer ON subscriptions(stripe_customer_id);
CREATE INDEX idx_subscriptions_stripe_subscription ON subscriptions(stripe_subscription_id);
CREATE INDEX idx_subscriptions_status ON subscriptions(status) WHERE status IN ('active', 'trialing', 'past_due');
CREATE INDEX idx_subscriptions_trial_end ON subscriptions(trial_end) WHERE trial_end IS NOT NULL;

-- Usage limits indexes
CREATE INDEX idx_usage_limits_user_id ON usage_limits(user_id);

-- Promo codes indexes
CREATE INDEX idx_promo_codes_code ON promo_codes(code);
CREATE INDEX idx_promo_codes_active ON promo_codes(active) WHERE active = true;
CREATE INDEX idx_promo_codes_expires ON promo_codes(expires_at) WHERE expires_at IS NOT NULL;

-- User promo codes indexes
CREATE INDEX idx_user_promo_codes_user_id ON user_promo_codes(user_id);
CREATE INDEX idx_user_promo_codes_promo_id ON user_promo_codes(promo_code_id);

-- Webhook events indexes
CREATE INDEX idx_webhook_events_event_id ON stripe_webhook_events(event_id);
CREATE INDEX idx_webhook_events_event_type ON stripe_webhook_events(event_type);
CREATE INDEX idx_webhook_events_processed ON stripe_webhook_events(processed, created_at) WHERE processed = false;
CREATE INDEX idx_webhook_events_customer ON stripe_webhook_events(stripe_customer_id) WHERE stripe_customer_id IS NOT NULL;

-- =====================================================
-- TRIGGERS
-- =====================================================
-- Auto-update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_subscriptions_updated_at
  BEFORE UPDATE ON subscriptions
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_usage_limits_updated_at
  BEFORE UPDATE ON usage_limits
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_promo_codes_updated_at
  BEFORE UPDATE ON promo_codes
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- =====================================================
-- INITIAL DATA
-- =====================================================
-- Create usage_limits entry for all existing users
INSERT INTO usage_limits (user_id)
SELECT id FROM users
WHERE id NOT IN (SELECT user_id FROM usage_limits);

COMMENT ON TABLE subscriptions IS 'Migration 001 completed successfully';
