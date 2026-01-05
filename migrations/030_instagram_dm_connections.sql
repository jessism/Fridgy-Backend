-- Migration: 030_instagram_dm_connections.sql
-- Purpose: Store Instagram DM bot connections for recipe saving (mirrors messenger_connections)

-- Create instagram_dm_connections table
CREATE TABLE IF NOT EXISTS instagram_dm_connections (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  instagram_user_id TEXT UNIQUE NOT NULL,  -- IGSID (Instagram-Scoped ID)
  instagram_username TEXT,                  -- For display purposes
  linked_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  last_message_at TIMESTAMP WITH TIME ZONE,

  CONSTRAINT unique_user_instagram_dm UNIQUE (user_id)
);

-- Index for fast IGSID lookups (primary use case)
CREATE INDEX IF NOT EXISTS idx_instagram_dm_igsid ON instagram_dm_connections(instagram_user_id);

-- Index for user lookups (for settings page)
CREATE INDEX IF NOT EXISTS idx_instagram_dm_user ON instagram_dm_connections(user_id);

-- Create table for storing pending link tokens (temporary, expire after 10 minutes)
CREATE TABLE IF NOT EXISTS instagram_dm_link_tokens (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  instagram_user_id TEXT NOT NULL,
  token TEXT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  expires_at TIMESTAMP WITH TIME ZONE DEFAULT NOW() + INTERVAL '10 minutes',
  used BOOLEAN DEFAULT FALSE
);

-- Index for token lookups
CREATE INDEX IF NOT EXISTS idx_instagram_dm_link_token ON instagram_dm_link_tokens(token);

-- Index for cleanup of expired tokens
CREATE INDEX IF NOT EXISTS idx_instagram_dm_link_expires ON instagram_dm_link_tokens(expires_at);

-- RLS policies
ALTER TABLE instagram_dm_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE instagram_dm_link_tokens ENABLE ROW LEVEL SECURITY;

-- Users can only see their own Instagram DM connection
CREATE POLICY "Users can view own instagram dm connection"
  ON instagram_dm_connections FOR SELECT
  USING (auth.uid() = user_id);

-- Users can insert their own Instagram DM connection
CREATE POLICY "Users can insert own instagram dm connection"
  ON instagram_dm_connections FOR INSERT
  WITH CHECK (auth.uid() = user_id);

-- Users can delete their own Instagram DM connection
CREATE POLICY "Users can delete own instagram dm connection"
  ON instagram_dm_connections FOR DELETE
  USING (auth.uid() = user_id);

-- Service role can do everything (for backend operations)
CREATE POLICY "Service role full access to instagram_dm_connections"
  ON instagram_dm_connections FOR ALL
  USING (auth.role() = 'service_role');

CREATE POLICY "Service role full access to instagram_dm_link_tokens"
  ON instagram_dm_link_tokens FOR ALL
  USING (auth.role() = 'service_role');
