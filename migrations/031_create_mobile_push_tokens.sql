-- Migration 031: Create mobile_push_tokens table for Expo push notifications
-- This is SEPARATE from push_subscriptions (web push).
-- The two systems are independent at the data layer.

CREATE TABLE IF NOT EXISTS mobile_push_tokens (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  expo_token TEXT NOT NULL,
  device_name TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(user_id, expo_token)
);

CREATE INDEX IF NOT EXISTS idx_mobile_push_tokens_user_id
  ON mobile_push_tokens(user_id);

CREATE INDEX IF NOT EXISTS idx_mobile_push_tokens_expo_token
  ON mobile_push_tokens(expo_token);

-- Reuse trigger function from migration 015
CREATE TRIGGER update_mobile_push_tokens_updated_at
  BEFORE UPDATE ON mobile_push_tokens
  FOR EACH ROW
  EXECUTE FUNCTION update_push_updated_at_column();
