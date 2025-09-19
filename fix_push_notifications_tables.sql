-- Fix Push Notification Tables for Custom Users
-- Run this in Supabase SQL Editor to fix the foreign key constraints

-- Step 1: Drop existing tables (if they exist with wrong references)
DROP TABLE IF EXISTS notification_logs CASCADE;
DROP TABLE IF EXISTS notification_preferences CASCADE;
DROP TABLE IF EXISTS push_subscriptions CASCADE;

-- Step 2: Create push_subscriptions table with correct reference to public.users
CREATE TABLE push_subscriptions (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL,
  keys JSONB NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(user_id, endpoint)
);

-- Step 3: Create notification_preferences table with correct reference
CREATE TABLE notification_preferences (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  enabled BOOLEAN DEFAULT true,
  days_before_expiry INTEGER[] DEFAULT ARRAY[1, 3],
  notification_time TIME DEFAULT '09:00:00',
  timezone TEXT DEFAULT 'America/Los_Angeles',
  quiet_hours_start TIME DEFAULT '22:00:00',
  quiet_hours_end TIME DEFAULT '08:00:00',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(user_id)
);

-- Step 4: Create notification_logs table with correct references
CREATE TABLE notification_logs (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  item_id INTEGER REFERENCES fridge_items(id) ON DELETE SET NULL,
  notification_type TEXT NOT NULL,
  title TEXT,
  body TEXT,
  data JSONB,
  sent_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  success BOOLEAN DEFAULT true,
  error_message TEXT
);

-- Step 5: Create indexes for performance
CREATE INDEX idx_push_subscriptions_user_id ON push_subscriptions(user_id);
CREATE INDEX idx_notification_preferences_user_id ON notification_preferences(user_id);
CREATE INDEX idx_notification_logs_user_id ON notification_logs(user_id);
CREATE INDEX idx_notification_logs_sent_at ON notification_logs(sent_at);
CREATE INDEX idx_notification_logs_type ON notification_logs(notification_type);

-- Step 6: Create function for timestamp updates
CREATE OR REPLACE FUNCTION update_push_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Step 7: Create triggers for automatic timestamp updates
CREATE TRIGGER update_push_subscriptions_updated_at
BEFORE UPDATE ON push_subscriptions
FOR EACH ROW
EXECUTE FUNCTION update_push_updated_at_column();

CREATE TRIGGER update_notification_preferences_updated_at
BEFORE UPDATE ON notification_preferences
FOR EACH ROW
EXECUTE FUNCTION update_push_updated_at_column();

-- Step 8: Grant permissions (no RLS since using custom auth)
GRANT ALL ON push_subscriptions TO anon, authenticated;
GRANT ALL ON notification_preferences TO anon, authenticated;
GRANT ALL ON notification_logs TO anon, authenticated;

-- Step 9: Verify tables were created successfully
SELECT
    table_name,
    COUNT(*) as column_count
FROM information_schema.columns
WHERE table_name IN ('push_subscriptions', 'notification_preferences', 'notification_logs')
GROUP BY table_name
ORDER BY table_name;

-- Expected output:
-- notification_logs: 10 columns
-- notification_preferences: 9 columns
-- push_subscriptions: 6 columns