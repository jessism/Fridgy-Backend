-- Migration: Calendar Sync Feature
-- Adds tables for Google Calendar integration

-- Table: user_calendar_connections
-- Stores OAuth tokens for Google Calendar access
CREATE TABLE IF NOT EXISTS user_calendar_connections (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider VARCHAR(20) NOT NULL DEFAULT 'google',
  access_token TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  token_expiry TIMESTAMP WITH TIME ZONE,
  calendar_id VARCHAR(255) DEFAULT 'primary',
  connected_email VARCHAR(255),
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(user_id, provider)
);

CREATE INDEX IF NOT EXISTS idx_calendar_connections_user ON user_calendar_connections(user_id);

-- Table: user_meal_time_preferences
-- Stores user's default meal times and sync preferences
CREATE TABLE IF NOT EXISTS user_meal_time_preferences (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  breakfast_time TIME DEFAULT '08:00',
  lunch_time TIME DEFAULT '12:00',
  dinner_time TIME DEFAULT '19:00',
  snack_time TIME DEFAULT '15:00',
  meal_duration_minutes INTEGER DEFAULT 30,
  auto_sync BOOLEAN DEFAULT FALSE,
  timezone VARCHAR(50) DEFAULT 'America/Los_Angeles',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(user_id)
);

CREATE INDEX IF NOT EXISTS idx_meal_time_prefs_user ON user_meal_time_preferences(user_id);

-- Add columns to meal_plans table for calendar sync tracking
ALTER TABLE meal_plans ADD COLUMN IF NOT EXISTS scheduled_time TIME;
ALTER TABLE meal_plans ADD COLUMN IF NOT EXISTS calendar_event_id VARCHAR(255);
ALTER TABLE meal_plans ADD COLUMN IF NOT EXISTS synced_at TIMESTAMP WITH TIME ZONE;

CREATE INDEX IF NOT EXISTS idx_meal_plans_calendar_event ON meal_plans(calendar_event_id) WHERE calendar_event_id IS NOT NULL;

-- Grant permissions
GRANT SELECT, INSERT, UPDATE, DELETE ON user_calendar_connections TO anon;
GRANT ALL ON user_calendar_connections TO service_role;

GRANT SELECT, INSERT, UPDATE, DELETE ON user_meal_time_preferences TO anon;
GRANT ALL ON user_meal_time_preferences TO service_role;
