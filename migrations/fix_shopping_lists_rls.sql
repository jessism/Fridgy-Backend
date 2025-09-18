-- Fix Shopping Lists RLS Infinite Recursion
-- This disables Row Level Security on shopping list tables
-- because we're using JWT auth in the backend, not Supabase auth

-- Disable RLS on all shopping list tables
ALTER TABLE shopping_lists DISABLE ROW LEVEL SECURITY;
ALTER TABLE shopping_list_items DISABLE ROW LEVEL SECURITY;
ALTER TABLE shopping_list_members DISABLE ROW LEVEL SECURITY;
ALTER TABLE shopping_list_activities DISABLE ROW LEVEL SECURITY;

-- Drop all existing RLS policies to clean up
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

-- Note: Authentication is handled by the Express backend using JWT tokens,
-- not by Supabase RLS. The backend ensures users can only access their own lists.