-- Migration 072: Add result_data to import_jobs
-- Scan/Voice recipe jobs return an extracted recipe for PREVIEW (not saved
-- server-side like URL imports), so the job needs to carry the recipe JSON.
-- The backend tolerates this column being absent (in-memory fallback), but
-- applying it makes results survive server restarts.

ALTER TABLE import_jobs ADD COLUMN IF NOT EXISTS result_data JSONB;
