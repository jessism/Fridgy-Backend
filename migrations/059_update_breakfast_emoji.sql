-- Update breakfast reminder emoji from 🌅 to ☀️
-- Migration: 059 - Update Breakfast Reminder Emoji
-- Date: 2026-03-30
-- Purpose: Change breakfast reminder icon to be more visually appealing

UPDATE notification_preferences
SET daily_reminders = jsonb_set(
  daily_reminders,
  '{breakfast_reminder,emoji}',
  '"☀️"'
)
WHERE daily_reminders->'breakfast_reminder' IS NOT NULL;

-- Verify the update
SELECT
  user_id,
  daily_reminders->'breakfast_reminder'->>'emoji' as breakfast_emoji
FROM notification_preferences
WHERE daily_reminders->'breakfast_reminder' IS NOT NULL
LIMIT 5;
