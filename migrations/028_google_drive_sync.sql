-- Migration: Google Drive Recipe Sync
-- Date: December 23, 2025
-- Description: Adds Google Drive integration for auto-saving recipes as PDFs

-- =====================================================
-- 1. Create user_drive_connections table
-- =====================================================
CREATE TABLE IF NOT EXISTS user_drive_connections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  access_token TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  token_expiry TIMESTAMP WITH TIME ZONE,
  connected_email VARCHAR(255),
  folder_id VARCHAR(255),  -- "Trackabite Recipes" folder ID in Drive
  is_active BOOLEAN DEFAULT TRUE,
  auto_sync_enabled BOOLEAN DEFAULT FALSE,  -- Manual sync by default
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(user_id)
);

-- Index for faster lookups
CREATE INDEX IF NOT EXISTS idx_drive_connections_user_id ON user_drive_connections(user_id);
CREATE INDEX IF NOT EXISTS idx_drive_connections_active ON user_drive_connections(user_id, is_active);

-- =====================================================
-- 2. Add Drive sync tracking columns to saved_recipes
-- =====================================================
ALTER TABLE saved_recipes
ADD COLUMN IF NOT EXISTS drive_file_id VARCHAR(255),
ADD COLUMN IF NOT EXISTS drive_synced_at TIMESTAMP WITH TIME ZONE,
ADD COLUMN IF NOT EXISTS drive_sync_status VARCHAR(20) DEFAULT NULL;
-- Status values: NULL (not applicable), 'pending', 'synced', 'failed'

-- Index for finding unsynced recipes
CREATE INDEX IF NOT EXISTS idx_saved_recipes_drive_status
ON saved_recipes(drive_sync_status)
WHERE drive_sync_status IS NOT NULL;

-- =====================================================
-- 3. Row Level Security
-- =====================================================
ALTER TABLE user_drive_connections ENABLE ROW LEVEL SECURITY;

-- Users can only access their own drive connections
CREATE POLICY "Users can view own drive connections" ON user_drive_connections
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own drive connections" ON user_drive_connections
  FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own drive connections" ON user_drive_connections
  FOR UPDATE USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own drive connections" ON user_drive_connections
  FOR DELETE USING (auth.uid() = user_id);

-- Service role bypass for backend operations
CREATE POLICY "Service role full access to drive connections" ON user_drive_connections
  FOR ALL USING (auth.role() = 'service_role');

-- =====================================================
-- 4. Comments for documentation
-- =====================================================
COMMENT ON TABLE user_drive_connections IS 'Stores Google Drive OAuth connections for recipe PDF sync';
COMMENT ON COLUMN user_drive_connections.folder_id IS 'ID of the Trackabite Recipes folder in users Google Drive';
COMMENT ON COLUMN user_drive_connections.auto_sync_enabled IS 'If true, recipes auto-sync on save. Default is manual.';
COMMENT ON COLUMN saved_recipes.drive_file_id IS 'Google Drive file ID for the synced PDF';
COMMENT ON COLUMN saved_recipes.drive_sync_status IS 'Sync status: NULL, pending, synced, failed';
