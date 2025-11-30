-- Migration: Create meal_plans table for meal planning feature
-- This table stores user's planned meals for each day with 4 slots

CREATE TABLE IF NOT EXISTS meal_plans (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date DATE NOT NULL,
  meal_type VARCHAR(20) NOT NULL CHECK (meal_type IN ('breakfast', 'lunch', 'dinner', 'snack')),
  recipe_id UUID REFERENCES saved_recipes(id) ON DELETE SET NULL,
  recipe_source VARCHAR(20) DEFAULT 'saved' CHECK (recipe_source IN ('saved', 'ai', 'suggestion')),
  recipe_snapshot JSONB,  -- Cache: {title, image, readyInMinutes, source_type}
  is_completed BOOLEAN DEFAULT FALSE,
  completed_at TIMESTAMP WITH TIME ZONE,
  meal_log_id UUID REFERENCES meal_logs(id) ON DELETE SET NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

  -- Ensure only one recipe per meal slot per day per user
  UNIQUE(user_id, date, meal_type)
);

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_meal_plans_user_date ON meal_plans(user_id, date);
CREATE INDEX IF NOT EXISTS idx_meal_plans_user_date_range ON meal_plans(user_id, date DESC);

-- Grant permissions (using anon role since we're not using Supabase auth)
GRANT SELECT, INSERT, UPDATE, DELETE ON meal_plans TO anon;
GRANT ALL ON meal_plans TO service_role;

-- Note: RLS is handled at the application level via JWT validation in controllers
