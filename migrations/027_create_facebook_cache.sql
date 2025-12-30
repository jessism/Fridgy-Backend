-- Migration: Create facebook_cache table for caching Facebook extraction results
-- Date: December 21, 2025
-- Purpose: Cache Facebook reel/post extraction results to reduce API calls

-- Create facebook_cache table
CREATE TABLE IF NOT EXISTS facebook_cache (
  url TEXT PRIMARY KEY,
  data JSONB NOT NULL,
  extracted_with_apify BOOLEAN DEFAULT true,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  expires_at TIMESTAMP WITH TIME ZONE DEFAULT NOW() + INTERVAL '24 hours'
);

-- Create index for expired cache cleanup
CREATE INDEX IF NOT EXISTS idx_facebook_cache_expires ON facebook_cache(expires_at);

-- Create index for faster lookups with apify flag
CREATE INDEX IF NOT EXISTS idx_facebook_cache_apify ON facebook_cache(url, extracted_with_apify);

-- Enable Row Level Security (if needed for consistency, but cache is backend-only)
-- ALTER TABLE facebook_cache ENABLE ROW LEVEL SECURITY;

-- Grant permissions (adjust based on your Supabase setup)
-- GRANT ALL ON facebook_cache TO authenticated;
-- GRANT ALL ON facebook_cache TO service_role;

-- Add comment for documentation
COMMENT ON TABLE facebook_cache IS 'Cache for Facebook recipe extraction results (24-hour TTL)';
COMMENT ON COLUMN facebook_cache.url IS 'Facebook URL (post/reel) - primary key';
COMMENT ON COLUMN facebook_cache.data IS 'Cached extraction data in JSON format';
COMMENT ON COLUMN facebook_cache.extracted_with_apify IS 'Whether this was extracted using Apify';
COMMENT ON COLUMN facebook_cache.expires_at IS 'Cache expiration time (24 hours from creation)';
