-- Migration: Daily Engagement Reminders
-- Reshapes daily_reminders into the 3-tier daily engagement system:
--   Tier 1 (12:30) lunch_reminder  -> "Log your meal"
--   Tier 2 (17:30) dinner_prep     -> "What's for dinner? See what you can make"
--   Tier 3 (20:00) streak_at_risk  -> only if no qualifying action today (streakScheduler.js)
--
-- inventory_check is retired: it sat at the same 17:30 slot as tier 2 and said the
-- same thing. Left in place (disabled) so users can opt back in, rather than dropped.
--
-- Two parts are required: the column DEFAULT only applies to NEW rows, while existing
-- users each carry their own daily_reminders JSONB seeded by migration 016.
-- Run in Supabase SQL Editor.

-- Step 1: New default for future signups
ALTER TABLE notification_preferences
ALTER COLUMN daily_reminders SET DEFAULT '{
  "inventory_check": {
    "enabled": false,
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
    "enabled": true,
    "time": "17:30",
    "message": "What''s for dinner? See what you can make with what''s in your fridge",
    "emoji": "👨‍🍳"
  },
  "breakfast_reminder": {
    "enabled": false,
    "time": "08:00",
    "message": "Start your day right - check breakfast options",
    "emoji": "☀️"
  },
  "lunch_reminder": {
    "enabled": true,
    "time": "12:30",
    "message": "Did you have lunch? Log your meal",
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

-- Step 2: Backfill existing users.
-- Top-level || replaces only these three keys; any other reminder keys (and any custom
-- times the user set on them) are preserved. This DOES deliberately override a user's
-- own lunch/dinner customizations — accepted tradeoff to roll the new system out.
UPDATE notification_preferences
SET daily_reminders = COALESCE(daily_reminders, '{}'::jsonb) || jsonb_build_object(
  'lunch_reminder', jsonb_build_object(
    'enabled', true,
    'time', '12:30',
    'message', 'Did you have lunch? Log your meal',
    'emoji', '🥙'
  ),
  'dinner_prep', jsonb_build_object(
    'enabled', true,
    'time', '17:30',
    'message', 'What''s for dinner? See what you can make with what''s in your fridge',
    'emoji', '👨‍🍳'
  ),
  -- Preserve inventory_check's existing time/message/emoji, just switch it off
  'inventory_check', COALESCE(daily_reminders->'inventory_check', '{}'::jsonb)
    || jsonb_build_object('enabled', false)
);

-- Step 3: Verify the backfill hit existing rows
SELECT
  user_id,
  daily_reminders->'lunch_reminder'  AS lunch,
  daily_reminders->'dinner_prep'     AS dinner,
  daily_reminders->'inventory_check' AS inventory_check
FROM notification_preferences
LIMIT 5;
