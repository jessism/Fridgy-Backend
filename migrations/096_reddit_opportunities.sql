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
  category        TEXT,                         -- recipe_saving | recipe_import | recipe_app | recipe_organizer | meal_planning | other
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

-- ── Starter templates, one per live F5Bot keyword (tone: help first, disclose
--    being the founder, no hard sell). Replaced in the live table 2026-10-12;
--    the original four (incl. Food waste / Competitor thread) are retired. ──
INSERT INTO public.reddit_reply_templates (name, category, sort, body) VALUES
(
  'Save recipes', 'recipe_saving', 1,
  'I was the same — recipes scattered across screenshots, saved TikToks, bookmarks and a notes app, and I could never find the one I wanted. What finally worked was getting everything into one searchable place. I ended up building an app for exactly this (Trackabite, full disclosure it''s mine): you paste a link or share a TikTok/Instagram post and it saves the recipe cleanly. If you''d rather not use an app, one notes folder with a consistent naming scheme gets you most of the way.'
),
(
  'Import recipes', 'recipe_import', 2,
  'Importing from TikTok and Instagram is the hard part — most apps only handle normal recipe websites, because video recipes are buried in the caption or just spoken out loud. I built Trackabite partly because of this: share the post to it and it pulls the ingredients and steps into a proper recipe, and it works with regular recipe sites too. Free to try (5 imports a week on the free plan). Happy to help if you hit a post it can''t read.'
),
(
  'Recipe app recommendation', 'recipe_app', 3,
  'Depends what you want it for. Just storing recipes from websites: Paprika is a solid one-time purchase. Saving from TikTok/Instagram plus cooking from what''s already in your fridge: I built Trackabite for that, full disclosure. It imports recipes from social posts and links, tracks your groceries, and suggests what to cook before things go off. Free plan covers 5 imports a week, so it''s easy to try alongside whatever else you''re testing.'
),
(
  'Recipe organizer', 'recipe_organizer', 4,
  'The trick that made organizing stick for me: don''t build an elaborate category system up front. Get everything into one place first, then tag only what you actually cook. Folders by meal type plus a "made it, would make again" tag covers most of it. I built an app around that (Trackabite, it''s mine): it imports from links, TikTok and Instagram so getting the backlog in isn''t a chore. But the approach works in any app, or even a spreadsheet.'
),
(
  'Meal planning app', 'meal_planning', 5,
  'What made meal planning stick for me was planning from what''s already in the fridge first, then shopping only for the gaps — otherwise half the plan goes to waste. I built Trackabite to do that loop (full disclosure, it''s my app): it keeps track of your groceries, suggests recipes from them, and builds the shopping list grouped by recipe. The manual version, ten minutes on Sunday with the fridge open and a notepad, also beats any app you won''t stick with.'
)
ON CONFLICT (name) DO NOTHING;

-- Post-073 rule: every new table enables RLS, gets NO anon/authenticated grants
-- and NO policies. service_role (the only client) bypasses RLS.
ALTER TABLE public.reddit_opportunities   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reddit_reply_templates ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.reddit_opportunities   FROM anon, authenticated;
REVOKE ALL ON public.reddit_reply_templates FROM anon, authenticated;

NOTIFY pgrst, 'reload schema';
