-- User Onboarding Data Migration
-- Creates table to store user onboarding preferences for profile display
-- Compatible with custom JWT authentication (no Supabase Auth dependency)

-- Create user_onboarding_data table
CREATE TABLE IF NOT EXISTS user_onboarding_data (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  primary_goal VARCHAR(50),
  household_size INTEGER DEFAULT 1,
  weekly_budget DECIMAL(10,2),
  budget_currency VARCHAR(3) DEFAULT 'USD',
  notification_preferences JSONB DEFAULT '{}',
  onboarding_completed BOOLEAN DEFAULT false,
  onboarding_version VARCHAR(10) DEFAULT '1.0',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

  -- Ensure one record per user
  UNIQUE(user_id)
);

-- Create index for faster user lookups
CREATE INDEX IF NOT EXISTS idx_user_onboarding_data_user_id
ON user_onboarding_data(user_id);

-- Create index for onboarding completion status
CREATE INDEX IF NOT EXISTS idx_user_onboarding_data_completed
ON user_onboarding_data(onboarding_completed);

-- DISABLE RLS (following codebase pattern for custom JWT authentication)
-- We handle authorization in backend controllers via JWT middleware
ALTER TABLE user_onboarding_data DISABLE ROW LEVEL SECURITY;

-- Grant access to anon/authenticated (backend handles auth via JWT)
GRANT ALL ON user_onboarding_data TO anon, authenticated;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO anon, authenticated;

-- Create trigger for automatic updated_at timestamp
CREATE TRIGGER update_user_onboarding_data_updated_at
  BEFORE UPDATE ON user_onboarding_data
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- Add helpful comments
COMMENT ON TABLE user_onboarding_data IS 'Stores user onboarding preferences and choices for profile display and personalization';
COMMENT ON COLUMN user_onboarding_data.primary_goal IS 'User''s main goal: save_money, reduce_waste, eat_healthy, save_time, try_recipes, organize';
COMMENT ON COLUMN user_onboarding_data.household_size IS 'Number of people in household (1-10)';
COMMENT ON COLUMN user_onboarding_data.weekly_budget IS 'Weekly grocery budget amount';
COMMENT ON COLUMN user_onboarding_data.budget_currency IS 'Currency code (USD, EUR, etc.)';
COMMENT ON COLUMN user_onboarding_data.notification_preferences IS 'JSON object with notification settings: {mealReminders: boolean, expirationAlerts: boolean, weeklyReports: boolean}';
COMMENT ON COLUMN user_onboarding_data.onboarding_completed IS 'Whether user completed the full onboarding flow';
COMMENT ON COLUMN user_onboarding_data.onboarding_version IS 'Version of onboarding flow used (for tracking changes)';