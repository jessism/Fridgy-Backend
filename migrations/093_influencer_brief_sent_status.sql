-- Migration 093: 'brief_sent' status for creators who have been sent the brief
-- Date: 2026-09-30
--
-- Additive, safe to re-run. Apply after 091.
--
-- A reply is not a deal. Between "they wrote back" and "they signed" sits the
-- step that actually takes the work: writing the brief, pricing them, and
-- sending it. Without a status for it, every creator who replies stays under
-- 'replied' whether the brief went out an hour ago or a week ago, and there is
-- nothing on the dashboard that says which ones are still waiting on Jessie.
--
-- Sits between 'replied' and 'signed'. Like 'replied' it stops the follow-up
-- clock (that is handled in the state machine, not here) and it is excluded
-- from the reply scanner, which only looks at dm_needed / contacted /
-- followup_needed.

ALTER TABLE public.influencers
  DROP CONSTRAINT IF EXISTS influencers_status_check;

ALTER TABLE public.influencers
  ADD CONSTRAINT influencers_status_check CHECK (status IN (
    'pending_approval', 'warmup_needed', 'dm_needed', 'contacted',
    'followup_needed', 'replied', 'brief_sent', 'signed', 'declined', 'no_response',
    'rejected', 'hold', 'opted_out', 'bounced', 'removed'));

ALTER TABLE public.influencers
  ADD COLUMN IF NOT EXISTS brief_sent_at TIMESTAMPTZ;

NOTIFY pgrst, 'reload schema';
