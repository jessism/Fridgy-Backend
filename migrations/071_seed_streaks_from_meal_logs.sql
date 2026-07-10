-- Migration 071: Seed streaks from meal_logs history (one-time backfill)
-- Run AFTER 070 and AFTER the backend with streak recording is deployed.
-- ⚠️ Apply as a WHOLE in the Supabase SQL editor (scripts/runMigration.js splits on semicolons).
--
-- Rules:
--  - longest_streak = longest run of consecutive local days with at least one meal log
--  - current_streak is non-zero ONLY if the latest run ends today or yesterday in the
--    user's timezone (no phantom "live" streaks that would break the first night)
--  - streak_daily_log rows are seeded for the live run only (feeds the premium calendar)
--  - milestones are pre-inserted with dismissed = true (badge history, no confetti barrage)
--  - Idempotent: existing user_streaks rows are left untouched
--
-- Timezone caveat: uses users.timezone as of seed time (mostly the LA default until the
-- app's timezone sync ships). Best available data; go-forward streaks are exact.

-- Step 1: per-user local activity days
CREATE TEMP TABLE _streak_seed_days AS
SELECT
  ml.user_id,
  (ml.logged_at AT TIME ZONE COALESCE(u.timezone, 'America/Los_Angeles'))::date AS d,
  count(*)::int AS meal_count
FROM meal_logs ml
JOIN users u ON u.id = ml.user_id
GROUP BY ml.user_id, (ml.logged_at AT TIME ZONE COALESCE(u.timezone, 'America/Los_Angeles'))::date;

-- Step 2: gaps-and-islands — consecutive days share a group key
CREATE TEMP TABLE _streak_seed_runs AS
SELECT
  user_id, d, meal_count,
  d - (ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY d))::int AS grp
FROM _streak_seed_days;

CREATE TEMP TABLE _streak_seed_islands AS
SELECT user_id, grp, min(d) AS run_start, max(d) AS run_end, count(*)::int AS run_len
FROM _streak_seed_runs
GROUP BY user_id, grp;

-- Step 3: per-user summary (only the latest island can end at/after local yesterday)
CREATE TEMP TABLE _streak_seed_summary AS
SELECT
  i.user_id,
  max(i.run_len) AS longest_streak,
  max(i.run_end) AS last_activity_date,
  COALESCE(max(i.run_len) FILTER (
    WHERE i.run_end >= (now() AT TIME ZONE COALESCE(u.timezone, 'America/Los_Angeles'))::date - 1
  ), 0) AS current_streak,
  max(i.run_start) FILTER (
    WHERE i.run_end >= (now() AT TIME ZONE COALESCE(u.timezone, 'America/Los_Angeles'))::date - 1
  ) AS live_run_start,
  max(i.grp) FILTER (
    WHERE i.run_end >= (now() AT TIME ZONE COALESCE(u.timezone, 'America/Los_Angeles'))::date - 1
  ) AS live_grp,
  CASE WHEN u.tier IN ('premium', 'grandfathered') THEN 3 ELSE 1 END AS freezes
FROM _streak_seed_islands i
JOIN users u ON u.id = i.user_id
GROUP BY i.user_id, u.timezone, u.tier;

-- Step 4: seed user_streaks (never overwrite an existing row)
INSERT INTO user_streaks (
  user_id, current_streak, longest_streak, last_activity_date,
  streak_started_at, freezes_available, freezes_last_reset_at
)
SELECT
  user_id, current_streak, longest_streak, last_activity_date,
  live_run_start, freezes, now()
FROM _streak_seed_summary
ON CONFLICT (user_id) DO NOTHING;

-- Step 5: seed daily_log 'active' rows for the live run only
INSERT INTO streak_daily_log (user_id, date, status, action_type, action_count)
SELECT r.user_id, r.d, 'active', 'meal_log', r.meal_count
FROM _streak_seed_runs r
JOIN _streak_seed_summary s ON s.user_id = r.user_id AND s.live_grp = r.grp
ON CONFLICT (user_id, date) DO NOTHING;

-- Step 6: pre-dismissed milestone badges for thresholds already reached
INSERT INTO streak_milestones (user_id, milestone, badge_type, dismissed)
SELECT
  s.user_id, m.m,
  CASE WHEN m.m >= 60 THEN 'premium_exclusive' ELSE 'basic' END,
  true
FROM _streak_seed_summary s
CROSS JOIN (VALUES (3), (7), (14), (30), (60), (90), (365)) AS m(m)
WHERE m.m <= GREATEST(s.current_streak, s.longest_streak)
  AND NOT EXISTS (
    SELECT 1 FROM streak_milestones sm
    WHERE sm.user_id = s.user_id AND sm.milestone = m.m
  );

-- Step 7: report + cleanup
SELECT
  count(*) AS users_seeded,
  count(*) FILTER (WHERE current_streak > 0) AS live_streaks,
  max(longest_streak) AS max_longest
FROM _streak_seed_summary;

DROP TABLE _streak_seed_days;
DROP TABLE _streak_seed_runs;
DROP TABLE _streak_seed_islands;
DROP TABLE _streak_seed_summary;
