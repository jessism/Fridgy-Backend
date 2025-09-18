-- Shopping Lists Database Schema
-- This migration creates the necessary tables for collaborative shopping lists

-- Enable UUID extension if not already enabled
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- 1. shopping_lists table (main list metadata)
CREATE TABLE IF NOT EXISTS shopping_lists (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name VARCHAR(255) NOT NULL,
  owner_id UUID REFERENCES public.users(id) NOT NULL,
  color VARCHAR(7) DEFAULT '#c3f0ca',
  share_code VARCHAR(10) UNIQUE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  is_archived BOOLEAN DEFAULT FALSE,
  settings JSONB DEFAULT '{}'::jsonb
);

-- 2. shopping_list_items table
CREATE TABLE IF NOT EXISTS shopping_list_items (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  list_id UUID REFERENCES shopping_lists(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  quantity VARCHAR(100),
  unit VARCHAR(50),
  category VARCHAR(100) DEFAULT 'Other',
  is_checked BOOLEAN DEFAULT FALSE,
  checked_by UUID REFERENCES public.users(id),
  checked_by_name VARCHAR(255),
  checked_at TIMESTAMPTZ,
  added_by UUID REFERENCES public.users(id) NOT NULL,
  added_by_name VARCHAR(255),
  added_at TIMESTAMPTZ DEFAULT NOW(),
  notes TEXT,
  order_index INTEGER DEFAULT 0
);

-- 3. shopping_list_members table (simplified collaborators)
CREATE TABLE IF NOT EXISTS shopping_list_members (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  list_id UUID REFERENCES shopping_lists(id) ON DELETE CASCADE,
  user_id UUID REFERENCES public.users(id) ON DELETE CASCADE,
  role VARCHAR(20) DEFAULT 'member', -- 'owner' or 'member'
  joined_at TIMESTAMPTZ DEFAULT NOW(),
  invited_by UUID REFERENCES public.users(id),
  invited_by_name VARCHAR(255),
  UNIQUE(list_id, user_id)
);

-- 4. shopping_list_activities table (lightweight tracking)
CREATE TABLE IF NOT EXISTS shopping_list_activities (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  list_id UUID REFERENCES shopping_lists(id) ON DELETE CASCADE,
  user_id UUID REFERENCES public.users(id),
  user_name VARCHAR(255),
  action VARCHAR(50), -- 'checked', 'unchecked', 'added_item', 'deleted_item', 'joined_list', 'cleared_completed'
  item_name VARCHAR(255),
  timestamp TIMESTAMPTZ DEFAULT NOW(),
  metadata JSONB DEFAULT '{}'::jsonb
);

-- 5. Indexes for performance
CREATE INDEX IF NOT EXISTS idx_lists_owner ON shopping_lists(owner_id);
CREATE INDEX IF NOT EXISTS idx_lists_share_code ON shopping_lists(share_code);
CREATE INDEX IF NOT EXISTS idx_items_list ON shopping_list_items(list_id);
CREATE INDEX IF NOT EXISTS idx_items_list_checked ON shopping_list_items(list_id, is_checked);
CREATE INDEX IF NOT EXISTS idx_members_user ON shopping_list_members(user_id);
CREATE INDEX IF NOT EXISTS idx_members_list ON shopping_list_members(list_id);
CREATE INDEX IF NOT EXISTS idx_activities_list ON shopping_list_activities(list_id);
CREATE INDEX IF NOT EXISTS idx_activities_timestamp ON shopping_list_activities(list_id, timestamp DESC);

-- 6. Row Level Security (RLS)
ALTER TABLE shopping_lists ENABLE ROW LEVEL SECURITY;
ALTER TABLE shopping_list_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE shopping_list_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE shopping_list_activities ENABLE ROW LEVEL SECURITY;

-- Drop existing policies if they exist (to avoid conflicts)
DROP POLICY IF EXISTS "Users can view lists they're members of" ON shopping_lists;
DROP POLICY IF EXISTS "Users can create lists" ON shopping_lists;
DROP POLICY IF EXISTS "Owners can update their lists" ON shopping_lists;
DROP POLICY IF EXISTS "Owners can delete their lists" ON shopping_lists;
DROP POLICY IF EXISTS "Users can view items in lists they're members of" ON shopping_list_items;
DROP POLICY IF EXISTS "Members can manage items" ON shopping_list_items;
DROP POLICY IF EXISTS "Members can view other members" ON shopping_list_members;
DROP POLICY IF EXISTS "Users can manage membership" ON shopping_list_members;
DROP POLICY IF EXISTS "Members can view activities" ON shopping_list_activities;
DROP POLICY IF EXISTS "Members can create activities" ON shopping_list_activities;

-- RLS Policies for shopping_lists
CREATE POLICY "Users can view lists they're members of" ON shopping_lists
  FOR SELECT USING (
    owner_id = auth.uid() OR
    EXISTS (
      SELECT 1 FROM shopping_list_members
      WHERE list_id = shopping_lists.id
      AND user_id = auth.uid()
    )
  );

CREATE POLICY "Users can create lists" ON shopping_lists
  FOR INSERT WITH CHECK (owner_id = auth.uid());

CREATE POLICY "Owners can update their lists" ON shopping_lists
  FOR UPDATE USING (owner_id = auth.uid());

CREATE POLICY "Owners can delete their lists" ON shopping_lists
  FOR DELETE USING (owner_id = auth.uid());

-- RLS Policies for shopping_list_items
CREATE POLICY "Users can view items in lists they're members of" ON shopping_list_items
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM shopping_list_members
      WHERE list_id = shopping_list_items.list_id
      AND user_id = auth.uid()
    )
  );

CREATE POLICY "Members can manage items" ON shopping_list_items
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM shopping_list_members
      WHERE list_id = shopping_list_items.list_id
      AND user_id = auth.uid()
    )
  );

-- RLS Policies for shopping_list_members
CREATE POLICY "Members can view other members" ON shopping_list_members
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM shopping_list_members m
      WHERE m.list_id = shopping_list_members.list_id
      AND m.user_id = auth.uid()
    )
  );

CREATE POLICY "Users can manage membership" ON shopping_list_members
  FOR ALL USING (
    user_id = auth.uid() OR
    EXISTS (
      SELECT 1 FROM shopping_lists
      WHERE id = shopping_list_members.list_id
      AND owner_id = auth.uid()
    )
  );

-- RLS Policies for shopping_list_activities
CREATE POLICY "Members can view activities" ON shopping_list_activities
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM shopping_list_members
      WHERE list_id = shopping_list_activities.list_id
      AND user_id = auth.uid()
    )
  );

CREATE POLICY "Members can create activities" ON shopping_list_activities
  FOR INSERT WITH CHECK (
    EXISTS (
      SELECT 1 FROM shopping_list_members
      WHERE list_id = shopping_list_activities.list_id
      AND user_id = auth.uid()
    )
  );

-- Grant permissions
GRANT ALL ON shopping_lists TO authenticated;
GRANT ALL ON shopping_list_items TO authenticated;
GRANT ALL ON shopping_list_members TO authenticated;
GRANT ALL ON shopping_list_activities TO authenticated;

-- Create or replace function to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Drop trigger if exists and recreate
DROP TRIGGER IF EXISTS update_shopping_lists_updated_at ON shopping_lists;

-- Create trigger for shopping_lists updated_at
CREATE TRIGGER update_shopping_lists_updated_at
  BEFORE UPDATE ON shopping_lists
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();