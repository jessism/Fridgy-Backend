-- Migration 090: Remember WHY a creator was rejected
-- Date: 2026-09-15
--
-- Additive, safe to re-run. Apply after 089.
--
-- The reason is written on the dashboard when Jessie rejects a creator, and read
-- back by the discovery pipeline (trackabite-outreach/discover_run.py) so Gemini
-- scores similar profiles low instead of surfacing the same bad fit every week.
-- Rejected rows are the memory; there is no separate rules table.

ALTER TABLE public.influencers
  ADD COLUMN IF NOT EXISTS rejection_reason TEXT,
  ADD COLUMN IF NOT EXISTS rejected_at      TIMESTAMPTZ;

COMMENT ON COLUMN public.influencers.rejection_reason IS
  'Free text written at reject time. Fed into the scoring prompt as learned exclusions.';

-- Reading the most recent reasons is the only query pattern.
CREATE INDEX IF NOT EXISTS idx_influencers_rejected_at
  ON public.influencers (rejected_at DESC)
  WHERE rejection_reason IS NOT NULL;

NOTIFY pgrst, 'reload schema';
