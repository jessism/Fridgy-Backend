-- Migration: Add Daily Reminders to Notification System
-- This adds support for customizable daily reminder notifications
-- Date: 2025-01-27

-- Step 1: Add daily reminders configuration to notification_preferences
ALTER TABLE notification_preferences
ADD COLUMN IF NOT EXISTS daily_reminders JSONB DEFAULT '{
  "inventory_check": {
    "enabled": true,
    "time": "17:30",
    "message": "See what''s in your fridge",
    "emoji": "🥗"
  },
  "meal_planning": {
    "enabled": false,
    "time": "10:00",
    "day": "Sunday",
    "message": "Plan your meals for the week",
    "emoji": "📅"
  },
  "dinner_prep": {
    "enabled": false,
    "time": "16:00",
    "message": "Time to prep dinner!",
    "emoji": "👨‍🍳"
  },
  "breakfast_reminder": {
    "enabled": false,
    "time": "08:00",
    "message": "Start your day right - check breakfast options",
    "emoji": "🌅"
  },
  "lunch_reminder": {
    "enabled": false,
    "time": "12:00",
    "message": "Lunch time! See what you can make",
    "emoji": "🥙"
  },
  "shopping_reminder": {
    "enabled": false,
    "time": "18:00",
    "day": "Saturday",
    "message": "Time to plan your grocery shopping",
    "emoji": "🛒"
  }
}'::jsonb;

-- Step 2: Add reminder type tracking to notification_logs
ALTER TABLE notification_logs
ADD COLUMN IF NOT EXISTS reminder_type TEXT;

-- Step 3: Add sent_today tracking for daily reminders
CREATE TABLE IF NOT EXISTS daily_reminder_logs (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  reminder_type TEXT NOT NULL,
  sent_date DATE NOT NULL DEFAULT CURRENT_DATE,
  sent_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  success BOOLEAN DEFAULT true,
  UNIQUE(user_id, reminder_type, sent_date) -- Ensure one reminder per type per day
);

-- Step 4: Create indexes for better performance
CREATE INDEX IF NOT EXISTS idx_notification_logs_reminder_type ON notification_logs(reminder_type);
CREATE INDEX IF NOT EXISTS idx_daily_reminder_logs_user_date ON daily_reminder_logs(user_id, sent_date);
CREATE INDEX IF NOT EXISTS idx_daily_reminder_logs_type_date ON daily_reminder_logs(reminder_type, sent_date);

-- Step 5: Grant permissions
GRANT ALL ON daily_reminder_logs TO anon, authenticated;

-- Step 6: Helper function to get users needing reminders
CREATE OR REPLACE FUNCTION get_users_for_daily_reminder(
  reminder_type_param TEXT,
  current_hour INTEGER,
  current_minute INTEGER
)
RETURNS TABLE (
  user_id UUID,
  timezone TEXT,
  reminder_config JSONB
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    np.user_id,
    np.timezone,
    np.daily_reminders->reminder_type_param as reminder_config
  FROM notification_preferences np
  WHERE
    np.enabled = true
    AND (np.daily_reminders->reminder_type_param->>'enabled')::boolean = true
    AND NOT EXISTS (
      -- Check if reminder was already sent today
      SELECT 1 FROM daily_reminder_logs drl
      WHERE drl.user_id = np.user_id
        AND drl.reminder_type = reminder_type_param
        AND drl.sent_date = CURRENT_DATE
    );
END;
$$ LANGUAGE plpgsql;

-- Step 7: Verification query
SELECT
  column_name,
  data_type,
  is_nullable,
  column_default
FROM information_schema.columns
WHERE table_name = 'notification_preferences'
  AND column_name = 'daily_reminders';

-- Sample query to check configuration
SELECT
  user_id,
  daily_reminders->'inventory_check' as inventory_check_config,
  timezone
FROM notification_preferences
WHERE (daily_reminders->'inventory_check'->>'enabled')::boolean = true;