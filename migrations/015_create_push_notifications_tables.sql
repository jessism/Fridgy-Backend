-- Migration: Create Push Notification Tables
-- This creates the necessary tables for managing push notifications

-- Step 1: Create push_subscriptions table for storing browser push subscriptions
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL,
  keys JSONB NOT NULL, -- Stores p256dh and auth keys
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(user_id, endpoint) -- Prevent duplicate subscriptions per user
);

-- Step 2: Create notification_preferences table for user settings
CREATE TABLE IF NOT EXISTS notification_preferences (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  enabled BOOLEAN DEFAULT true,
  days_before_expiry INTEGER[] DEFAULT ARRAY[1, 3], -- Array of days before expiry to notify
  notification_time TIME DEFAULT '09:00:00', -- Preferred notification time
  timezone TEXT DEFAULT 'America/Los_Angeles',
  quiet_hours_start TIME DEFAULT '22:00:00', -- Don't notify after this time
  quiet_hours_end TIME DEFAULT '08:00:00', -- Don't notify before this time
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(user_id)
);

-- Step 3: Create notification_logs table to track sent notifications
CREATE TABLE IF NOT EXISTS notification_logs (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  item_id INTEGER REFERENCES fridge_items(id) ON DELETE SET NULL, -- Changed from UUID to INTEGER
  notification_type TEXT NOT NULL, -- 'expiry', 'test', 'recipe_suggestion', etc.
  title TEXT,
  body TEXT,
  data JSONB, -- Additional notification data
  sent_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  success BOOLEAN DEFAULT true,
  error_message TEXT
);

-- Step 4: Create indexes for better query performance
CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user_id ON push_subscriptions(user_id);
CREATE INDEX IF NOT EXISTS idx_notification_preferences_user_id ON notification_preferences(user_id);
CREATE INDEX IF NOT EXISTS idx_notification_logs_user_id ON notification_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_notification_logs_sent_at ON notification_logs(sent_at);
CREATE INDEX IF NOT EXISTS idx_notification_logs_type ON notification_logs(notification_type);

-- Step 5: Create function to auto-update updated_at timestamps
CREATE OR REPLACE FUNCTION update_push_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Step 6: Create triggers for automatic timestamp updates
CREATE TRIGGER update_push_subscriptions_updated_at
BEFORE UPDATE ON push_subscriptions
FOR EACH ROW
EXECUTE FUNCTION update_push_updated_at_column();

CREATE TRIGGER update_notification_preferences_updated_at
BEFORE UPDATE ON notification_preferences
FOR EACH ROW
EXECUTE FUNCTION update_push_updated_at_column();

-- Step 7: Grant necessary permissions
GRANT ALL ON push_subscriptions TO authenticated;
GRANT ALL ON notification_preferences TO authenticated;
GRANT ALL ON notification_logs TO authenticated;

-- Step 8: Add RLS policies (Row Level Security)
ALTER TABLE push_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_logs ENABLE ROW LEVEL SECURITY;

-- Users can only manage their own subscriptions
CREATE POLICY "Users can manage own push subscriptions" ON push_subscriptions
  FOR ALL USING (auth.uid() = user_id);

-- Users can only manage their own preferences
CREATE POLICY "Users can manage own notification preferences" ON notification_preferences
  FOR ALL USING (auth.uid() = user_id);

-- Users can only view their own notification logs
CREATE POLICY "Users can view own notification logs" ON notification_logs
  FOR SELECT USING (auth.uid() = user_id);

-- Verification query to check tables were created
SELECT table_name, column_name, data_type
FROM information_schema.columns
WHERE table_name IN ('push_subscriptions', 'notification_preferences', 'notification_logs')
ORDER BY table_name, ordinal_position;