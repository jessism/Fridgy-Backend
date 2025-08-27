-- Create meal_logs table if it doesn't exist
CREATE TABLE IF NOT EXISTS meal_logs (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  meal_photo_url TEXT,
  meal_type TEXT CHECK (meal_type IN ('breakfast', 'lunch', 'dinner', 'snack')),
  ingredients_detected JSONB,
  ingredients_logged JSONB,
  logged_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create index for faster queries
CREATE INDEX IF NOT EXISTS idx_meal_logs_user_id ON meal_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_meal_logs_logged_at ON meal_logs(logged_at DESC);
CREATE INDEX IF NOT EXISTS idx_meal_logs_meal_type ON meal_logs(meal_type);
CREATE INDEX IF NOT EXISTS idx_meal_logs_user_meal_type ON meal_logs(user_id, meal_type);

-- Enable Row Level Security
ALTER TABLE meal_logs ENABLE ROW LEVEL SECURITY;

-- Create policy to allow users to see only their own meal logs
CREATE POLICY "Users can view own meal logs" ON meal_logs
  FOR SELECT USING (auth.uid() = user_id);

-- Create policy to allow users to insert their own meal logs
CREATE POLICY "Users can insert own meal logs" ON meal_logs
  FOR INSERT WITH CHECK (auth.uid() = user_id);

-- Grant permissions
GRANT ALL ON meal_logs TO authenticated;
GRANT ALL ON meal_logs TO anon;