-- Add meal_type column to meal_logs table
ALTER TABLE meal_logs 
ADD COLUMN IF NOT EXISTS meal_type TEXT 
CHECK (meal_type IN ('breakfast', 'lunch', 'dinner', 'snack', NULL));

-- Create index for meal_type for faster queries
CREATE INDEX IF NOT EXISTS idx_meal_logs_meal_type ON meal_logs(meal_type);

-- Create index for user_id and meal_type combination for analytics
CREATE INDEX IF NOT EXISTS idx_meal_logs_user_meal_type ON meal_logs(user_id, meal_type);
