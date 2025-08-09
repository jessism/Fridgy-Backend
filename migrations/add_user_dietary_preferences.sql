-- Add user dietary preferences table for AI recipe recommendations
-- Run this after the existing users table is created

CREATE TABLE IF NOT EXISTS user_dietary_preferences (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  dietary_restrictions TEXT[], -- Array of restrictions like 'vegetarian', 'vegan', etc.
  allergies TEXT[], -- Array of specific allergies
  custom_allergies TEXT, -- Open text field for additional allergies
  preferred_cuisines TEXT[], -- Array of preferred cuisines
  cooking_time_preference VARCHAR(20), -- Single choice: 'under_15', '15_30', '30_60', 'over_60'
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(user_id) -- One preference record per user
);

-- Create index for faster user lookups
CREATE INDEX IF NOT EXISTS idx_user_dietary_preferences_user_id ON user_dietary_preferences(user_id);

-- Enable Row Level Security (RLS)
ALTER TABLE user_dietary_preferences ENABLE ROW LEVEL SECURITY;

-- Create policy for users to read their own preferences
CREATE POLICY "Users can view own preferences" ON user_dietary_preferences
  FOR SELECT USING (user_id = auth.uid() OR user_id IN (
    SELECT id FROM users WHERE id = auth.uid()
  ));

-- Create policy for users to insert their own preferences  
CREATE POLICY "Users can insert own preferences" ON user_dietary_preferences
  FOR INSERT WITH CHECK (user_id = auth.uid() OR user_id IN (
    SELECT id FROM users WHERE id = auth.uid()
  ));

-- Create policy for users to update their own preferences
CREATE POLICY "Users can update own preferences" ON user_dietary_preferences
  FOR UPDATE USING (user_id = auth.uid() OR user_id IN (
    SELECT id FROM users WHERE id = auth.uid()
  ));

-- Create policy for users to delete their own preferences
CREATE POLICY "Users can delete own preferences" ON user_dietary_preferences
  FOR DELETE USING (user_id = auth.uid() OR user_id IN (
    SELECT id FROM users WHERE id = auth.uid()
  ));

-- Create trigger to automatically update updated_at timestamp
CREATE TRIGGER update_user_dietary_preferences_updated_at 
  BEFORE UPDATE ON user_dietary_preferences 
  FOR EACH ROW 
  EXECUTE FUNCTION update_updated_at_column();

-- Grant necessary permissions
GRANT ALL ON user_dietary_preferences TO anon, authenticated;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO anon, authenticated;

-- Insert sample data for testing (optional)
-- INSERT INTO user_dietary_preferences (user_id, dietary_restrictions, allergies, preferred_cuisines, cooking_time_preference)
-- VALUES (
--   (SELECT id FROM users LIMIT 1),
--   ARRAY['vegetarian', 'gluten-free'],
--   ARRAY['nuts', 'dairy'],
--   ARRAY['italian', 'mediterranean'],
--   '30_60'
-- ) ON CONFLICT (user_id) DO NOTHING;