-- Migration: Add transcript caching to youtube_cache table
-- Date: March 18, 2026
-- Purpose: Cache audio transcripts to avoid re-transcribing same videos for multiple users

-- Add columns for audio transcript caching
ALTER TABLE youtube_cache
ADD COLUMN IF NOT EXISTS audio_transcript TEXT,
ADD COLUMN IF NOT EXISTS transcript_cached_at TIMESTAMP WITH TIME ZONE;

-- Create index for efficient lookup of cached transcripts
CREATE INDEX IF NOT EXISTS idx_youtube_cache_transcript
ON youtube_cache(url)
WHERE audio_transcript IS NOT NULL;

-- Add comments for documentation
COMMENT ON COLUMN youtube_cache.audio_transcript IS 'Cached audio transcription from video (if extracted)';
COMMENT ON COLUMN youtube_cache.transcript_cached_at IS 'Timestamp when transcript was cached';

-- Verify migration
SELECT
  column_name,
  data_type,
  is_nullable
FROM information_schema.columns
WHERE table_name = 'youtube_cache'
  AND column_name IN ('audio_transcript', 'transcript_cached_at')
ORDER BY column_name;
