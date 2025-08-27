-- Fix meal_logs table to work with custom users table instead of auth.users
-- Run this in your Supabase SQL Editor

-- Step 1: Drop existing policies
DROP POLICY IF EXISTS "Users can view own meal logs" ON meal_logs;
DROP POLICY IF EXISTS "Users can insert own meal logs" ON meal_logs;

-- Step 2: Drop the existing meal_logs table (this will also drop indexes)
DROP TABLE IF EXISTS meal_logs CASCADE;

-- Step 3: Create meal_logs table with reference to custom users table
CREATE TABLE meal_logs (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES public.users(id) ON DELETE CASCADE,  -- Changed from auth.users to public.users
  meal_photo_url TEXT,
  meal_type TEXT CHECK (meal_type IN ('breakfast', 'lunch', 'dinner', 'snack')),
  ingredients_detected JSONB,
  ingredients_logged JSONB,
  logged_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Step 4: Create indexes for performance
CREATE INDEX idx_meal_logs_user_id ON meal_logs(user_id);
CREATE INDEX idx_meal_logs_logged_at ON meal_logs(logged_at DESC);
CREATE INDEX idx_meal_logs_meal_type ON meal_logs(meal_type);
CREATE INDEX idx_meal_logs_user_meal_type ON meal_logs(user_id, meal_type);

-- Step 5: Disable RLS for now (since we're not using Supabase Auth)
-- We'll rely on the backend JWT validation instead
ALTER TABLE meal_logs DISABLE ROW LEVEL SECURITY;

-- Step 6: Grant permissions to allow operations
GRANT ALL ON meal_logs TO authenticated;
GRANT ALL ON meal_logs TO anon;
GRANT ALL ON meal_logs TO service_role;

-- Optional: If you want to enable RLS later with custom users table,
-- you would need to create a custom function that validates the JWT token
-- and matches it with the users table. For now, we'll handle auth in the backend.

-- Verify the table was created successfully
SELECT 
    'meal_logs table created successfully' as status,
    COUNT(*) as column_count
FROM 
    information_schema.columns 
WHERE 
    table_name = 'meal_logs';