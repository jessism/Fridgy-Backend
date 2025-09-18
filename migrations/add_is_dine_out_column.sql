-- Add is_dine_out column to meal_logs table
-- This migration adds support for tracking dine-out meals that don't require ingredient deduction

-- Add the new column with a default value of false
ALTER TABLE meal_logs
ADD COLUMN IF NOT EXISTS is_dine_out BOOLEAN DEFAULT FALSE;

-- Add index for performance when filtering dine-out meals
CREATE INDEX IF NOT EXISTS idx_meal_logs_is_dine_out ON meal_logs(is_dine_out);

-- Add composite index for user-specific dine-out queries
CREATE INDEX IF NOT EXISTS idx_meal_logs_user_dine_out ON meal_logs(user_id, is_dine_out);

-- Comment for documentation
COMMENT ON COLUMN meal_logs.is_dine_out IS 'Indicates whether the meal was eaten outside (dine-out) and should not deduct from inventory';