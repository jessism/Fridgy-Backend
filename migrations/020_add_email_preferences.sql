-- Migration: Add Email Notification Preferences
-- This adds email notification settings to the notification system
-- Date: 2025-01-20

-- Step 1: Add email preference columns to notification_preferences
ALTER TABLE notification_preferences
ADD COLUMN IF NOT EXISTS email_daily_expiry BOOLEAN DEFAULT true,
ADD COLUMN IF NOT EXISTS email_weekly_summary BOOLEAN DEFAULT true,
ADD COLUMN IF NOT EXISTS email_tips_updates BOOLEAN DEFAULT true,
ADD COLUMN IF NOT EXISTS last_daily_email_sent TIMESTAMP WITH TIME ZONE,
ADD COLUMN IF NOT EXISTS last_weekly_email_sent TIMESTAMP WITH TIME ZONE,
ADD COLUMN IF NOT EXISTS last_tips_email_sent TIMESTAMP WITH TIME ZONE;

-- Step 2: Add email notification type to notification_logs
-- This allows tracking both push and email notifications in the same table
ALTER TABLE notification_logs
ADD COLUMN IF NOT EXISTS notification_method TEXT DEFAULT 'push' CHECK (notification_method IN ('push', 'email', 'both'));

-- Step 3: Create indexes for email tracking
CREATE INDEX IF NOT EXISTS idx_notification_logs_method ON notification_logs(notification_method);
CREATE INDEX IF NOT EXISTS idx_notification_preferences_email_daily ON notification_preferences(email_daily_expiry) WHERE email_daily_expiry = true;
CREATE INDEX IF NOT EXISTS idx_notification_preferences_email_weekly ON notification_preferences(email_weekly_summary) WHERE email_weekly_summary = true;

-- Step 4: Verification query to check columns were added
SELECT
  column_name,
  data_type,
  column_default,
  is_nullable
FROM information_schema.columns
WHERE table_name = 'notification_preferences'
  AND column_name LIKE 'email%'
ORDER BY column_name;

-- Step 5: Sample query to see user email preferences
SELECT
  user_id,
  email_daily_expiry,
  email_weekly_summary,
  email_tips_updates,
  timezone,
  last_daily_email_sent,
  last_weekly_email_sent
FROM notification_preferences
LIMIT 5;
