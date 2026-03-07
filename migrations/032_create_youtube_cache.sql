-- Migration 032: Create YouTube cache table for Apify extraction
-- Purpose: Cache YouTube video metadata and extraction results for 24 hours
-- Related: apifyYouTubeService.js

-- Create youtube_cache table
CREATE TABLE IF NOT EXISTS youtube_cache (
  url TEXT PRIMARY KEY,
  data JSONB NOT NULL,
  extracted_with_apify BOOLEAN DEFAULT true,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  expires_at TIMESTAMP WITH TIME ZONE DEFAULT NOW() + INTERVAL '24 hours'
);

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_youtube_cache_expires ON youtube_cache(expires_at);
CREATE INDEX IF NOT EXISTS idx_youtube_cache_apify ON youtube_cache(url, extracted_with_apify);

-- Add comments for documentation
COMMENT ON TABLE youtube_cache IS 'Cache for YouTube recipe extraction (24-hour TTL). Shares usage limits with Instagram and Facebook.';
COMMENT ON COLUMN youtube_cache.url IS 'Normalized YouTube URL (youtube.com/watch?v=VIDEO_ID format)';
COMMENT ON COLUMN youtube_cache.data IS 'Extracted video metadata, description, transcript, and recipe data (JSONB)';
COMMENT ON COLUMN youtube_cache.extracted_with_apify IS 'Whether this was extracted using Apify (always true for this table)';
COMMENT ON COLUMN youtube_cache.expires_at IS 'Cache expiration timestamp (24 hours from creation)';
