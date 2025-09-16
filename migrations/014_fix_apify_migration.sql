-- Fix Apify Migration - Handle Existing Policies
-- This migration fixes the partial migration issue where policies already existed

-- First, check what exists (for debugging)
-- SELECT EXISTS (
--   SELECT FROM information_schema.tables
--   WHERE table_name = 'apify_usage'
-- ) as apify_table_exists;

-- SELECT column_name FROM information_schema.columns
-- WHERE table_name = 'saved_recipes'
-- AND column_name IN ('video_url', 'video_duration', 'extracted_with_apify');

-- Create apify_usage table if it doesn't exist
CREATE TABLE IF NOT EXISTS apify_usage (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  month_year VARCHAR(7) NOT NULL, -- Format: '2025-01' for January 2025
  usage_count INTEGER DEFAULT 0,
  last_used TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

  -- Ensure one record per user per month
  UNIQUE(user_id, month_year)
);

-- Add video-related fields to saved_recipes table (safe with IF NOT EXISTS)
ALTER TABLE saved_recipes
ADD COLUMN IF NOT EXISTS video_url TEXT,
ADD COLUMN IF NOT EXISTS video_duration INTEGER, -- Duration in seconds
ADD COLUMN IF NOT EXISTS extracted_with_apify BOOLEAN DEFAULT false,
ADD COLUMN IF NOT EXISTS video_analysis_confidence FLOAT,
ADD COLUMN IF NOT EXISTS video_view_count INTEGER;

-- Add Apify flag to instagram_cache table
ALTER TABLE instagram_cache
ADD COLUMN IF NOT EXISTS extracted_with_apify BOOLEAN DEFAULT false;

-- Create function (will replace if exists)
CREATE OR REPLACE FUNCTION increment_apify_usage(
  p_user_id UUID,
  p_month_year VARCHAR(7)
)
RETURNS void AS $$
BEGIN
  UPDATE apify_usage
  SET
    usage_count = usage_count + 1,
    last_used = NOW()
  WHERE
    user_id = p_user_id AND
    month_year = p_month_year;
END;
$$ LANGUAGE plpgsql;

-- Create indexes if they don't exist
CREATE INDEX IF NOT EXISTS idx_apify_usage_user_month
ON apify_usage(user_id, month_year);

CREATE INDEX IF NOT EXISTS idx_saved_recipes_apify
ON saved_recipes(extracted_with_apify)
WHERE extracted_with_apify = true;

-- Enable RLS (safe to run multiple times)
ALTER TABLE apify_usage ENABLE ROW LEVEL SECURITY;

-- Drop existing policies first, then recreate (handles the conflict)
DROP POLICY IF EXISTS "Users can view own Apify usage" ON apify_usage;
DROP POLICY IF EXISTS "Users can create own Apify usage" ON apify_usage;
DROP POLICY IF EXISTS "Users can update own Apify usage" ON apify_usage;

-- Create fresh policies
CREATE POLICY "Users can view own Apify usage" ON apify_usage
  FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can create own Apify usage" ON apify_usage
  FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own Apify usage" ON apify_usage
  FOR UPDATE
  USING (auth.uid() = user_id);

-- Grant necessary permissions
GRANT ALL ON apify_usage TO authenticated;
GRANT EXECUTE ON FUNCTION increment_apify_usage TO authenticated;

-- Add comments for documentation
COMMENT ON TABLE apify_usage IS 'Tracks monthly Apify API usage for free tier management';
COMMENT ON COLUMN apify_usage.month_year IS 'Month in YYYY-MM format for usage tracking';
COMMENT ON COLUMN apify_usage.usage_count IS 'Number of Apify API calls this month';

COMMENT ON COLUMN saved_recipes.video_url IS 'Direct URL to Instagram video file from Apify';
COMMENT ON COLUMN saved_recipes.video_duration IS 'Video duration in seconds';
COMMENT ON COLUMN saved_recipes.extracted_with_apify IS 'Whether recipe was extracted using Apify (premium)';
COMMENT ON COLUMN saved_recipes.video_analysis_confidence IS 'AI confidence score for video-based extraction';
COMMENT ON COLUMN saved_recipes.video_view_count IS 'Instagram video view count';

-- Migration complete
-- Run this in Supabase SQL Editor, then restart your backend server