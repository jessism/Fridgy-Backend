-- Migration 096: Reddit opportunities — F5Bot-sourced threads where Trackabite fits, + reply templates
-- Date: 2026-10-10
--
-- ⚠️ Apply this file as a WHOLE in the Supabase SQL editor. There is no
--    migration ledger; every statement is idempotent so re-running is safe.
--
-- Written by: Backend services/redditOpportunities (ingest / scoring / alert crons).
-- Read/updated by: Backend routes/adminReddit.js (admin console page).
-- Plan: trackabite-mobile/MD_files/PLAN_REDDIT_ALERT_OCT10.md

-- ── Opportunities: one row per Reddit post/comment an alert matched ──
CREATE TABLE IF NOT EXISTS public.reddit_opportunities (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source          TEXT NOT NULL DEFAULT 'f5bot',
  reddit_url      TEXT NOT NULL UNIQUE,         -- canonical URL, the dedup key
  post_id         TEXT,                         -- reddit thing id from the URL
  comment_id      TEXT,                         -- set when the hit is a comment
  kind            TEXT CHECK (kind IS NULL OR kind IN ('post', 'comment')),
  subreddit       TEXT,
  title           TEXT,
  excerpt         TEXT,                         -- whatever snippet the alert carried
  keyword         TEXT,                         -- the F5Bot keyword that matched
  author          TEXT,
  raw             JSONB NOT NULL DEFAULT '{}',  -- {gmail_id, block} for re-parsing

  score           SMALLINT CHECK (score IS NULL OR score BETWEEN 0 AND 100),
  score_reason    TEXT,
  category        TEXT,                         -- recipe_saving | food_waste | meal_planning | competitor | other
  suggested_reply TEXT,                         -- drafted only for instant-alert scores

  status          TEXT NOT NULL DEFAULT 'new'
                    CHECK (status IN ('new', 'replied', 'dismissed', 'filtered')),
  alerted_at      TIMESTAMPTZ,                  -- instant email sent
  digested_at     TIMESTAMPTZ,                  -- included in a daily digest
  notes           TEXT,

  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_reddit_opps_status   ON public.reddit_opportunities (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_reddit_opps_unscored ON public.reddit_opportunities (created_at)
  WHERE score IS NULL;

-- ── Reply templates: copy-paste starters shown on the admin page ──
CREATE TABLE IF NOT EXISTS public.reddit_reply_templates (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL UNIQUE,
  category    TEXT,
  body        TEXT NOT NULL,
  sort        SMALLINT NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- updated_at maintenance — reuses the generic trigger function from 089
-- (it only sets NEW.updated_at; the "influencers" in the name is historical).
DROP TRIGGER IF EXISTS trg_reddit_opps_updated_at ON public.reddit_opportunities;
CREATE TRIGGER trg_reddit_opps_updated_at
  BEFORE UPDATE ON public.reddit_opportunities
  FOR EACH ROW EXECUTE FUNCTION public.influencers_set_updated_at();

DROP TRIGGER IF EXISTS trg_reddit_templates_updated_at ON public.reddit_reply_templates;
CREATE TRIGGER trg_reddit_templates_updated_at
  BEFORE UPDATE ON public.reddit_reply_templates
  FOR EACH ROW EXECUTE FUNCTION public.influencers_set_updated_at();

-- ── Starter templates (tone: help first, disclose being the founder, no hard sell) ──
INSERT INTO public.reddit_reply_templates (name, category, sort, body) VALUES
(
  'Recipe saving', 'recipe_saving', 1,
  'I had the same problem — screenshots and saved TikToks everywhere and never finding anything again. I actually ended up building an app for this (Trackabite) that imports recipes from links/TikToks and keeps them searchable in one place. Happy to answer questions if useful — and if you''d rather not use an app, a simple Notes folder with a strict naming scheme honestly gets you 80% of the way.'
),
(
  'Food waste', 'food_waste', 2,
  'What helped me most was keeping a live list of what''s actually in the fridge with rough expiry dates — most waste is just forgetting what''s in there. I built an app called Trackabite that does this (snap your groceries, it tracks them and suggests recipes for what''s expiring), but even a whiteboard on the fridge door works if you keep it honest.'
),
(
  'Meal planning', 'meal_planning', 3,
  'A loop that works for me: plan the week from what''s already in the fridge first, then shop only the gaps. I built Trackabite to automate exactly that (fridge inventory → recipe suggestions → shopping list grouped by recipe), full disclosure it''s my app. The manual version — ten minutes on Sunday with the fridge open — also beats any app you won''t stick with.'
),
(
  'Competitor thread', 'competitor', 4,
  'Adding one more option since you''re comparing: I''m the founder of Trackabite, which does {{what_they_asked_for}} plus fridge/expiry tracking so recipes connect to what you actually have. Free tier covers {{free_tier_fact}}. The others mentioned here are solid too — depends if you want recipe storage only or the inventory side as well.'
)
ON CONFLICT (name) DO NOTHING;

-- Post-073 rule: every new table enables RLS, gets NO anon/authenticated grants
-- and NO policies. service_role (the only client) bypasses RLS.
ALTER TABLE public.reddit_opportunities   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reddit_reply_templates ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.reddit_opportunities   FROM anon, authenticated;
REVOKE ALL ON public.reddit_reply_templates FROM anon, authenticated;

NOTIFY pgrst, 'reload schema';
