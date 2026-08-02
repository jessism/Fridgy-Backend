-- 075: One-time premium-voice trial for free users.
-- Set when a non-premium user first uses a premium cooking voice; the
-- backend allows premium voices for 2 hours from this timestamp, then
-- requires a subscription. Never reset (the trial is once per account).
ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS voice_trial_started_at TIMESTAMPTZ;
