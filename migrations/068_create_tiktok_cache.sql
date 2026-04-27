-- Migration: Create tiktok_cache table for caching TikTok extraction results
-- Date: April 27, 2026
-- Purpose: Cache TikTok video extraction results to reduce API calls

-- Create tiktok_cache table
CREATE TABLE IF NOT EXISTS tiktok_cache (
  url TEXT PRIMARY KEY,
  data JSONB NOT NULL,
  extracted_with_apify BOOLEAN DEFAULT true,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  expires_at TIMESTAMP WITH TIME ZONE DEFAULT NOW() + INTERVAL '24 hours'
);

-- Create index for expired cache cleanup
CREATE INDEX IF NOT EXISTS idx_tiktok_cache_expires ON tiktok_cache(expires_at);

-- Create index for faster lookups with apify flag
CREATE INDEX IF NOT EXISTS idx_tiktok_cache_apify ON tiktok_cache(url, extracted_with_apify);

-- Add comment for documentation
COMMENT ON TABLE tiktok_cache IS 'Cache for TikTok recipe extraction results (24-hour TTL)';
COMMENT ON COLUMN tiktok_cache.url IS 'TikTok URL (video) - primary key';
COMMENT ON COLUMN tiktok_cache.data IS 'Cached extraction data in JSON format';
COMMENT ON COLUMN tiktok_cache.extracted_with_apify IS 'Whether this was extracted using Apify';
COMMENT ON COLUMN tiktok_cache.expires_at IS 'Cache expiration time (24 hours from creation)';
