-- Quick fix: Disable RLS on meal_logs table to test if that's the issue
-- This is a temporary fix to verify the problem is with RLS/auth mismatch
-- Run this in your Supabase SQL Editor

-- Step 1: Drop existing RLS policies
DROP POLICY IF EXISTS "Users can view own meal logs" ON meal_logs;
DROP POLICY IF EXISTS "Users can insert own meal logs" ON meal_logs;

-- Step 2: Disable RLS (this will allow all operations regardless of user)
ALTER TABLE meal_logs DISABLE ROW LEVEL SECURITY;

-- Step 3: Grant full permissions
GRANT ALL ON meal_logs TO authenticated;
GRANT ALL ON meal_logs TO anon;
GRANT ALL ON meal_logs TO service_role;

-- Verify RLS is disabled
SELECT 
    tablename,
    rowsecurity 
FROM 
    pg_tables 
WHERE 
    schemaname = 'public' 
    AND tablename = 'meal_logs';

-- Note: This is a TEMPORARY fix for testing. 
-- For production, run fix_meal_logs_table.sql to properly update the table structure.