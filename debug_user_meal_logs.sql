-- Debug queries to check user and meal_logs setup
-- Run these in Supabase SQL Editor to diagnose the issue

-- 1. Check all users in the public.users table
SELECT id, email, first_name, created_at 
FROM public.users
ORDER BY created_at DESC;

-- 2. Check if meal_logs table exists and its structure
SELECT 
    column_name, 
    data_type, 
    is_nullable,
    column_default
FROM information_schema.columns 
WHERE table_name = 'meal_logs'
ORDER BY ordinal_position;

-- 3. Check foreign key constraints on meal_logs
SELECT
    tc.constraint_name,
    tc.constraint_type,
    kcu.column_name,
    ccu.table_name AS foreign_table_name,
    ccu.column_name AS foreign_column_name
FROM 
    information_schema.table_constraints AS tc 
    JOIN information_schema.key_column_usage AS kcu
      ON tc.constraint_name = kcu.constraint_name
    JOIN information_schema.constraint_column_usage AS ccu
      ON ccu.constraint_name = tc.constraint_name
WHERE tc.table_name = 'meal_logs' 
    AND tc.constraint_type = 'FOREIGN KEY';

-- 4. Check if there are any meal_logs entries (should be empty if nothing saved)
SELECT COUNT(*) as total_meal_logs FROM meal_logs;

-- 5. Test insert with a known user ID (replace 'YOUR_USER_ID' with an actual ID from query #1)
-- IMPORTANT: Copy a user ID from query #1 results and replace YOUR_USER_ID below
/*
INSERT INTO meal_logs (
    user_id,
    meal_type,
    ingredients_detected,
    ingredients_logged
) VALUES (
    'YOUR_USER_ID'::uuid,  -- Replace with actual user ID from query #1
    'lunch',
    '[{"name": "test"}]'::jsonb,
    '[{"name": "test"}]'::jsonb
);
*/

-- 6. Check RLS status
SELECT 
    schemaname,
    tablename,
    rowsecurity
FROM pg_tables 
WHERE tablename = 'meal_logs';