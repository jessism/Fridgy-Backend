-- Migration 089: Influencer outreach engine — creators, batches, posts, touches, seen, runs
-- Date: 2026-09-14
--
-- ⚠️ Apply this file as a WHOLE in the Supabase SQL editor (scripts/runMigration.js
--    splits on semicolons and would break the trigger function below). There is no
--    migration ledger; every statement is idempotent so re-running is safe.
--
-- Written by: trackabite-outreach (Python, GitHub Actions) inserts creators + posts
--             + runs + seen via PostgREST with the service key.
-- Read/updated by: Backend routes/adminInfluencers.js (admin console tab) and
--             services/influencerOutreach (emails, follow-ups, reply scan, mirror).
-- Plan: trackabite-mobile/MD_files/PLAN_INFLUENCER_AGENT_SPT13.md

-- ── Runs: one row per discovery run (also the FK target for influencers.run_id) ──
CREATE TABLE IF NOT EXISTS public.influencer_runs (
  id            SERIAL PRIMARY KEY,
  started_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at   TIMESTAMPTZ,
  platform      TEXT,
  hashtags      TEXT[] NOT NULL DEFAULT '{}',
  candidates    INTEGER NOT NULL DEFAULT 0,   -- profiles that passed code filters
  added         INTEGER NOT NULL DEFAULT 0,   -- rows inserted as pending_approval
  apify_runs    INTEGER NOT NULL DEFAULT 0,
  cost_usd      NUMERIC(8,4),
  error         TEXT,
  notes         TEXT
);

-- ── Batches: one per outreach session (target 10 creators) ──
CREATE TABLE IF NOT EXISTS public.influencer_batches (
  id              SERIAL PRIMARY KEY,
  opened_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  warmup_done_at  TIMESTAMPTZ,
  status          TEXT NOT NULL DEFAULT 'reviewing'
                    CHECK (status IN ('reviewing', 'warmup_open', 'contacted')),
  target          INTEGER NOT NULL DEFAULT 10,
  notes           TEXT
);

-- ── Influencers: the pipeline row ──
CREATE TABLE IF NOT EXISTS public.influencers (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id            INTEGER REFERENCES public.influencer_batches(id) ON DELETE SET NULL,
  run_id              INTEGER REFERENCES public.influencer_runs(id) ON DELETE SET NULL,

  platform            TEXT NOT NULL CHECK (platform IN ('instagram', 'tiktok')),
  handle              TEXT NOT NULL,
  profile_url         TEXT NOT NULL,
  display_name        TEXT,
  followers           INTEGER,
  engagement_rate     NUMERIC(6,2),            -- percent, avg over recent posts
  bio                 TEXT,
  email               TEXT,                    -- public business email, if any
  external_url        TEXT,                    -- link in bio
  other_platforms     JSONB NOT NULL DEFAULT '[]', -- [{platform, handle, followers, url}]

  category            TEXT,
  score               SMALLINT CHECK (score BETWEEN 1 AND 10),
  why                 TEXT,
  evidence_caption    TEXT,                    -- the real caption the drafts refer to

  draft_dm            TEXT,                    -- editable copy shown/sent
  agent_draft_dm      TEXT,                    -- original, never edited (edit-rate metric)
  draft_email_subject TEXT,
  draft_email         TEXT,

  recommended_fee     INTEGER,                 -- USD, from the pricing formula
  fee_breakdown       JSONB,                   -- {base, engagement_mult, platform_mult, ...}
  agreed_fee          INTEGER,                 -- USD, set by hand
  campaign_slug       TEXT,                    -- ct= value for the App Store link
  tracking_link       TEXT,
  promo_code          TEXT,

  status              TEXT NOT NULL DEFAULT 'pending_approval'
                        CHECK (status IN (
                          'pending_approval', 'warmup_needed', 'dm_needed', 'contacted',
                          'followup_needed', 'replied', 'signed', 'declined', 'no_response',
                          'rejected', 'hold', 'opted_out', 'bounced')),
  hold_note           TEXT,
  notes               TEXT,

  discovered_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  approved_at         TIMESTAMPTZ,
  warmup_done_at      TIMESTAMPTZ,
  contacted_at        TIMESTAMPTZ,
  next_touch_at       TIMESTAMPTZ,
  touches_sent        SMALLINT NOT NULL DEFAULT 0,
  last_touch_at       TIMESTAMPTZ,
  replied_at          TIMESTAMPTZ,
  reply_channel       TEXT CHECK (reply_channel IS NULL OR reply_channel IN ('email', 'dm')),
  brief_sent_at       TIMESTAMPTZ,
  outcome             TEXT,
  email_error         TEXT,

  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (platform, handle)
);

CREATE INDEX IF NOT EXISTS idx_influencers_status      ON public.influencers (status);
CREATE INDEX IF NOT EXISTS idx_influencers_batch       ON public.influencers (batch_id);
CREATE INDEX IF NOT EXISTS idx_influencers_next_touch  ON public.influencers (next_touch_at)
  WHERE status IN ('contacted', 'followup_needed');
CREATE INDEX IF NOT EXISTS idx_influencers_updated_at  ON public.influencers (updated_at DESC);

-- ── Posts: the 5 latest posts per creator, with the drafted comment for warm-up ──
CREATE TABLE IF NOT EXISTS public.influencer_posts (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  influencer_id   UUID NOT NULL REFERENCES public.influencers(id) ON DELETE CASCADE,
  post_url        TEXT NOT NULL,
  short_code      TEXT,
  caption         TEXT,
  posted_at       TIMESTAMPTZ,
  likes           INTEGER,
  comments        INTEGER,
  comment_draft   TEXT,                        -- NULL = like only
  liked_at        TIMESTAMPTZ,
  commented_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (influencer_id, post_url)
);

CREATE INDEX IF NOT EXISTS idx_influencer_posts_influencer ON public.influencer_posts (influencer_id);

-- ── Touches: every DM/email, scheduled or sent ──
CREATE TABLE IF NOT EXISTS public.influencer_touches (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  influencer_id   UUID NOT NULL REFERENCES public.influencers(id) ON DELETE CASCADE,
  step            SMALLINT NOT NULL CHECK (step BETWEEN 1 AND 4),
  channel         TEXT NOT NULL CHECK (channel IN ('email', 'dm')),
  scheduled_for   TIMESTAMPTZ,
  subject         TEXT,
  body            TEXT,
  sent_at         TIMESTAMPTZ,
  sent_by         TEXT CHECK (sent_by IS NULL OR sent_by IN ('auto', 'human')),
  message_id      TEXT,                        -- SMTP Message-ID, for reply matching
  edited          BOOLEAN NOT NULL DEFAULT FALSE,
  error           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_influencer_touches_influencer ON public.influencer_touches (influencer_id, step);
CREATE INDEX IF NOT EXISTS idx_influencer_touches_message_id ON public.influencer_touches (message_id)
  WHERE message_id IS NOT NULL;

-- ── Seen: evaluated but not added (skip for 90 days) ──
CREATE TABLE IF NOT EXISTS public.influencer_seen (
  platform        TEXT NOT NULL,
  handle          TEXT NOT NULL,
  seen_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  verdict         TEXT NOT NULL,               -- filtered | low_score | not_english | error
  score           SMALLINT,
  reason          TEXT,
  run_id          INTEGER REFERENCES public.influencer_runs(id) ON DELETE SET NULL,
  PRIMARY KEY (platform, handle)
);

-- ── updated_at maintenance ──
CREATE OR REPLACE FUNCTION public.influencers_set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_influencers_updated_at ON public.influencers;
CREATE TRIGGER trg_influencers_updated_at
  BEFORE UPDATE ON public.influencers
  FOR EACH ROW EXECUTE FUNCTION public.influencers_set_updated_at();

-- Post-073 rule: every new table enables RLS, gets NO anon/authenticated grants
-- and NO policies. service_role (the only client) bypasses RLS.
ALTER TABLE public.influencer_runs     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.influencer_batches  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.influencers         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.influencer_posts    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.influencer_touches  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.influencer_seen     ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.influencer_runs     FROM anon, authenticated;
REVOKE ALL ON public.influencer_batches  FROM anon, authenticated;
REVOKE ALL ON public.influencers         FROM anon, authenticated;
REVOKE ALL ON public.influencer_posts    FROM anon, authenticated;
REVOKE ALL ON public.influencer_touches  FROM anon, authenticated;
REVOKE ALL ON public.influencer_seen     FROM anon, authenticated;
REVOKE ALL ON SEQUENCE public.influencer_runs_id_seq    FROM anon, authenticated;
REVOKE ALL ON SEQUENCE public.influencer_batches_id_seq FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.influencers_set_updated_at() FROM anon, authenticated;

NOTIFY pgrst, 'reload schema';
