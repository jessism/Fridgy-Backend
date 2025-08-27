-- Add meal_name column to meal_logs table
-- This will store a human-readable name for the meal (e.g., "Chicken and Broccoli")

ALTER TABLE meal_logs 
ADD COLUMN IF NOT EXISTS meal_name TEXT;

-- Add an index for faster searching by meal name
CREATE INDEX IF NOT EXISTS idx_meal_logs_meal_name ON meal_logs(meal_name);

-- Update the RLS policies to ensure they still work with the new column
-- (No changes needed since policies are based on user_id, not specific columns)

-- Optional: Set a default value for existing records
-- UPDATE meal_logs SET meal_name = 'Home-cooked Meal' WHERE meal_name IS NULL;