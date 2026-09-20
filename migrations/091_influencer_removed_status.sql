-- Migration 091: 'removed' status for creators who left the pipeline
-- Date: 2026-09-20
--
-- Additive, safe to re-run. Apply after 090.
--
-- Rejecting is a judgement about fit, made at review time, and its reason is fed
-- back into scoring. Removing is different: the account was deleted, went
-- private or asked to be dropped, and nothing should be inferred from it. Same
-- rejection_reason column holds the note; only status = 'rejected' rows are read
-- back as learned exclusions by trackabite-outreach.

ALTER TABLE public.influencers
  DROP CONSTRAINT IF EXISTS influencers_status_check;

ALTER TABLE public.influencers
  ADD CONSTRAINT influencers_status_check CHECK (status IN (
    'pending_approval', 'warmup_needed', 'dm_needed', 'contacted',
    'followup_needed', 'replied', 'signed', 'declined', 'no_response',
    'rejected', 'hold', 'opted_out', 'bounced', 'removed'));

NOTIFY pgrst, 'reload schema';
