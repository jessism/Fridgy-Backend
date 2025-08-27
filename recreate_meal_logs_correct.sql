-- Recreate meal_logs table with correct reference to custom users table
-- Run this in Supabase SQL Editor: https://supabase.com/dashboard/project/aimvjpndmipmtavpmjnn/sql

-- Step 1: Drop the existing meal_logs table completely (including all constraints)
DROP TABLE IF EXISTS meal_logs CASCADE;

-- Step 2: Create meal_logs table with correct foreign key to public.users
CREATE TABLE meal_logs (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,  -- Will reference public.users(id)
  meal_photo_url TEXT,
  meal_type TEXT CHECK (meal_type IN ('breakfast', 'lunch', 'dinner', 'snack')),
  ingredients_detected JSONB,
  ingredients_logged JSONB,
  logged_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  
  -- Add foreign key constraint to public.users table (not auth.users!)
  CONSTRAINT meal_logs_user_id_fkey FOREIGN KEY (user_id) 
    REFERENCES public.users(id) ON DELETE CASCADE
);

-- Step 3: Create indexes for better query performance
CREATE INDEX idx_meal_logs_user_id ON meal_logs(user_id);
CREATE INDEX idx_meal_logs_logged_at ON meal_logs(logged_at DESC);
CREATE INDEX idx_meal_logs_meal_type ON meal_logs(meal_type);
CREATE INDEX idx_meal_logs_user_meal_type ON meal_logs(user_id, meal_type);

-- Step 4: Disable RLS (we're using JWT authentication in backend, not Supabase Auth)
ALTER TABLE meal_logs DISABLE ROW LEVEL SECURITY;

-- Step 5: Grant permissions to ensure access works
GRANT ALL ON meal_logs TO authenticated;
GRANT ALL ON meal_logs TO anon;
GRANT ALL ON meal_logs TO service_role;

-- Step 6: Verify the table was created with correct foreign key
SELECT 
    tc.table_name,
    tc.constraint_name,
    tc.constraint_type,
    kcu.column_name,
    ccu.table_name AS foreign_table_name,
    ccu.column_name AS foreign_column_name
FROM 
    information_schema.table_constraints AS tc 
    JOIN information_schema.key_column_usage AS kcu
      ON tc.constraint_name = kcu.constraint_name
      AND tc.table_schema = kcu.table_schema
    JOIN information_schema.constraint_column_usage AS ccu
      ON ccu.constraint_name = tc.constraint_name
      AND ccu.table_schema = tc.table_schema
WHERE tc.table_name = 'meal_logs' 
    AND tc.constraint_type = 'FOREIGN KEY';

-- Expected result: Should show foreign key referencing public.users(id)