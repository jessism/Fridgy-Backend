-- Add timezone support to users table for scalable timezone handling
-- Run this in Supabase SQL Editor: https://supabase.com/dashboard/project/aimvjpndmipmtavpmjnn/sql

-- Step 1: Add timezone column to users table
ALTER TABLE public.users 
ADD COLUMN IF NOT EXISTS timezone VARCHAR(50) DEFAULT 'America/Los_Angeles';

-- Step 2: Add comment for documentation
COMMENT ON COLUMN public.users.timezone IS 'IANA timezone identifier (e.g., America/New_York, Europe/London, Asia/Tokyo)';

-- Step 3: Create index for potential future queries by timezone
CREATE INDEX IF NOT EXISTS idx_users_timezone ON public.users(timezone);

-- Step 4: Update existing users to have a default timezone
-- This uses America/Los_Angeles as default, but you can change based on your user base
UPDATE public.users 
SET timezone = 'America/Los_Angeles' 
WHERE timezone IS NULL;

-- Step 5: Verify the column was added
SELECT 
    column_name,
    data_type,
    column_default,
    is_nullable
FROM information_schema.columns 
WHERE table_name = 'users' 
AND column_name = 'timezone';

-- Step 6: Show sample of users with their timezones
SELECT id, email, first_name, timezone, created_at 
FROM public.users 
LIMIT 5;