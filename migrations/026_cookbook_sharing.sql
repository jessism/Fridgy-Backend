-- Migration: Cookbook Sharing Feature
-- Date: 2025-12-07
-- Description: Adds sharing functionality to cookbooks (similar to shopping lists)

-- =====================================================
-- 1. Add share_code column to cookbooks table
-- =====================================================
ALTER TABLE cookbooks ADD COLUMN IF NOT EXISTS share_code VARCHAR(10) UNIQUE;

-- Index for share_code lookups
CREATE INDEX IF NOT EXISTS idx_cookbooks_share_code ON cookbooks(share_code);

-- =====================================================
-- 2. Create cookbook_members table
-- =====================================================
CREATE TABLE IF NOT EXISTS cookbook_members (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cookbook_id UUID NOT NULL REFERENCES cookbooks(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role VARCHAR(20) DEFAULT 'member',  -- 'owner' or 'member'
  joined_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  invited_by UUID REFERENCES users(id),
  invited_by_name VARCHAR(255),
  UNIQUE(cookbook_id, user_id)
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_cookbook_members_cookbook_id ON cookbook_members(cookbook_id);
CREATE INDEX IF NOT EXISTS idx_cookbook_members_user_id ON cookbook_members(user_id);

-- =====================================================
-- 3. Add joined_cookbooks_count to usage_limits table
-- =====================================================
-- Note: Tier limits are defined in code (usageService.js), not in database
-- This just adds the column to track user's joined cookbook count
ALTER TABLE usage_limits ADD COLUMN IF NOT EXISTS joined_cookbooks_count INTEGER DEFAULT 0;

-- =====================================================
-- 4. Migrate existing cookbooks to have owner in members
-- =====================================================
-- This ensures existing cookbooks have their owner as a member
-- Run this after creating the cookbook_members table
INSERT INTO cookbook_members (cookbook_id, user_id, role, joined_at)
SELECT
  c.id as cookbook_id,
  c.user_id as user_id,
  'owner' as role,
  c.created_at as joined_at
FROM cookbooks c
WHERE NOT EXISTS (
  SELECT 1 FROM cookbook_members cm
  WHERE cm.cookbook_id = c.id AND cm.user_id = c.user_id
)
ON CONFLICT (cookbook_id, user_id) DO NOTHING;

-- =====================================================
-- 5. Comments
-- =====================================================
COMMENT ON TABLE cookbook_members IS 'Tracks members who have access to shared cookbooks';
COMMENT ON COLUMN cookbook_members.role IS 'owner = full control, member = can add recipes';
COMMENT ON COLUMN cookbooks.share_code IS 'Format: XXXX-XXXX, used for sharing via link';
