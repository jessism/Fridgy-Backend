-- Migration: 029_messenger_connections.sql
-- Purpose: Store Facebook Messenger bot connections for recipe saving

-- Create messenger_connections table
CREATE TABLE IF NOT EXISTS messenger_connections (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  facebook_psid TEXT UNIQUE NOT NULL,
  linked_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  last_message_at TIMESTAMP WITH TIME ZONE,

  CONSTRAINT unique_user_messenger UNIQUE (user_id)
);

-- Index for fast PSID lookups (primary use case)
CREATE INDEX IF NOT EXISTS idx_messenger_psid ON messenger_connections(facebook_psid);

-- Index for user lookups (for settings page)
CREATE INDEX IF NOT EXISTS idx_messenger_user ON messenger_connections(user_id);

-- Create table for storing pending link tokens (temporary, expire after 10 minutes)
CREATE TABLE IF NOT EXISTS messenger_link_tokens (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  facebook_psid TEXT NOT NULL,
  token TEXT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  expires_at TIMESTAMP WITH TIME ZONE DEFAULT NOW() + INTERVAL '10 minutes',
  used BOOLEAN DEFAULT FALSE
);

-- Index for token lookups
CREATE INDEX IF NOT EXISTS idx_messenger_link_token ON messenger_link_tokens(token);

-- Index for cleanup of expired tokens
CREATE INDEX IF NOT EXISTS idx_messenger_link_expires ON messenger_link_tokens(expires_at);

-- RLS policies
ALTER TABLE messenger_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE messenger_link_tokens ENABLE ROW LEVEL SECURITY;

-- Users can only see their own messenger connection
CREATE POLICY "Users can view own messenger connection"
  ON messenger_connections FOR SELECT
  USING (auth.uid() = user_id);

-- Users can insert their own messenger connection
CREATE POLICY "Users can insert own messenger connection"
  ON messenger_connections FOR INSERT
  WITH CHECK (auth.uid() = user_id);

-- Users can delete their own messenger connection
CREATE POLICY "Users can delete own messenger connection"
  ON messenger_connections FOR DELETE
  USING (auth.uid() = user_id);

-- Service role can do everything (for backend operations)
CREATE POLICY "Service role full access to messenger_connections"
  ON messenger_connections FOR ALL
  USING (auth.role() = 'service_role');

CREATE POLICY "Service role full access to messenger_link_tokens"
  ON messenger_link_tokens FOR ALL
  USING (auth.role() = 'service_role');
