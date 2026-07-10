-- Migration 070: Create Streaks Tables + record_streak_action RPC
-- Duolingo-style daily streaks: auto-freezes, 3-day grace restore (premium), milestones.
-- ⚠️ Apply this file as a WHOLE in the Supabase SQL editor.
--    scripts/runMigration.js splits on semicolons and breaks the plpgsql function body.

-- Step 1: user_streaks — one row per user, authoritative state
CREATE TABLE IF NOT EXISTS user_streaks (
  user_id UUID PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
  current_streak INTEGER NOT NULL DEFAULT 0,
  longest_streak INTEGER NOT NULL DEFAULT 0,
  last_activity_date DATE,              -- user-local date of last streak-counted action
  streak_started_at DATE,
  freezes_available INTEGER NOT NULL DEFAULT 1,
  freezes_used_total INTEGER NOT NULL DEFAULT 0,
  freezes_last_reset_at TIMESTAMP WITH TIME ZONE,
  lost_streak_value INTEGER,            -- grace period: streak value at time of break
  lost_streak_date DATE,
  grace_period_expires_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Step 2: streak_daily_log — one row per user per local day (presentation/audit)
CREATE TABLE IF NOT EXISTS streak_daily_log (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  date DATE NOT NULL,                   -- user-local date
  status TEXT NOT NULL CHECK (status IN ('active', 'frozen', 'missed', 'restored')),
  action_type TEXT,                     -- first action type of the day
  action_count INTEGER NOT NULL DEFAULT 1,
  freeze_used BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(user_id, date)                 -- concurrency guard for record_streak_action
);

-- Step 3: streak_milestones — no unique on (user_id, milestone): re-achievement celebrates again
CREATE TABLE IF NOT EXISTS streak_milestones (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  milestone INTEGER NOT NULL,
  badge_type TEXT NOT NULL DEFAULT 'basic' CHECK (badge_type IN ('basic', 'premium_exclusive')),
  achieved_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  dismissed BOOLEAN NOT NULL DEFAULT false
);

-- Step 4: indexes
CREATE INDEX IF NOT EXISTS idx_user_streaks_last_activity ON user_streaks(last_activity_date);
CREATE INDEX IF NOT EXISTS idx_streak_daily_log_user_date ON streak_daily_log(user_id, date DESC);
CREATE INDEX IF NOT EXISTS idx_streak_milestones_user ON streak_milestones(user_id, dismissed);

-- Step 5: updated_at trigger (reuses helper from migration 015)
CREATE TRIGGER update_user_streaks_updated_at
BEFORE UPDATE ON user_streaks
FOR EACH ROW
EXECUTE FUNCTION update_push_updated_at_column();

-- Step 6: permissions (custom JWT auth — authorization enforced in Express, matching migration 015)
GRANT ALL ON user_streaks TO anon, authenticated;
GRANT ALL ON streak_daily_log TO anon, authenticated;
GRANT ALL ON streak_milestones TO anon, authenticated;

-- Step 7: atomic streak recording.
-- All writes for one action happen inside this function under a row lock, so concurrent
-- actions (double-tap, meal log racing an inventory add) cannot double-increment.
-- Also does lazy catch-up: consumes freezes / breaks the streak inline for days the
-- overnight cron hasn't processed yet (e.g. user opens app at 00:01 local).
CREATE OR REPLACE FUNCTION record_streak_action(
  p_user_id UUID,
  p_action_type TEXT,
  p_is_premium BOOLEAN DEFAULT false
)
RETURNS JSONB AS $$
DECLARE
  v_tz TEXT;
  v_today DATE;
  v_yesterday DATE;
  v_streak user_streaks%ROWTYPE;
  v_inserted BOOLEAN;
  v_gap_day DATE;
  v_existing_status TEXT;
  v_gap_covered BOOLEAN := true;  -- gap days all frozen (or no gap) => continuity holds
  v_grace_active BOOLEAN;
  v_prev_streak INTEGER;
  v_new_milestone INTEGER := NULL;
  v_today_status TEXT := 'active';
  v_m INTEGER;
BEGIN
  -- User-local calendar day; targetDate/back-dating never reaches this function.
  SELECT COALESCE(timezone, 'America/Los_Angeles') INTO v_tz FROM users WHERE id = p_user_id;
  IF v_tz IS NULL THEN
    RAISE EXCEPTION 'record_streak_action: unknown user %', p_user_id;
  END IF;
  v_today := (now() AT TIME ZONE v_tz)::date;
  v_yesterday := v_today - 1;

  -- Lock (or create) the user's streak row for the rest of this transaction
  SELECT * INTO v_streak FROM user_streaks WHERE user_id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN
    INSERT INTO user_streaks (user_id, freezes_available, freezes_last_reset_at)
    VALUES (p_user_id, CASE WHEN p_is_premium THEN 3 ELSE 1 END, now())
    ON CONFLICT (user_id) DO NOTHING;
    SELECT * INTO v_streak FROM user_streaks WHERE user_id = p_user_id FOR UPDATE;
  END IF;

  -- Claim today. Losing a race (or a second action today) just bumps action_count.
  INSERT INTO streak_daily_log (user_id, date, status, action_type)
  VALUES (p_user_id, v_today, 'active', p_action_type)
  ON CONFLICT (user_id, date) DO UPDATE SET action_count = streak_daily_log.action_count + 1
  RETURNING (xmax = 0) INTO v_inserted;

  IF NOT v_inserted THEN
    RETURN jsonb_build_object(
      'current_streak', v_streak.current_streak,
      'longest_streak', v_streak.longest_streak,
      'streak_incremented', false,
      'new_milestone', NULL,
      'today_status', (SELECT status FROM streak_daily_log WHERE user_id = p_user_id AND date = v_today),
      'freezes_available', v_streak.freezes_available
    );
  END IF;

  -- Lazy catch-up: freeze each unprocessed missed day; break + grace when freezes run out.
  -- Frozen days (whether frozen here or by the overnight cron) preserve continuity
  -- without counting toward the streak.
  IF v_streak.last_activity_date IS NOT NULL
     AND v_streak.last_activity_date < v_yesterday
     AND v_streak.current_streak > 0 THEN
    v_gap_day := v_streak.last_activity_date + 1;
    WHILE v_gap_day <= v_yesterday LOOP
      SELECT status INTO v_existing_status
      FROM streak_daily_log WHERE user_id = p_user_id AND date = v_gap_day;
      IF FOUND THEN
        -- already processed (overnight cron); 'frozen' keeps continuity, 'missed' breaks it
        IF v_existing_status = 'missed' THEN
          v_gap_covered := false;
        END IF;
        v_gap_day := v_gap_day + 1;
        CONTINUE;
      END IF;
      IF v_streak.freezes_available > 0 THEN
        INSERT INTO streak_daily_log (user_id, date, status, freeze_used)
        VALUES (p_user_id, v_gap_day, 'frozen', true);
        v_streak.freezes_available := v_streak.freezes_available - 1;
        v_streak.freezes_used_total := v_streak.freezes_used_total + 1;
      ELSE
        INSERT INTO streak_daily_log (user_id, date, status)
        VALUES (p_user_id, v_gap_day, 'missed');
        v_streak.lost_streak_value := v_streak.current_streak;
        v_streak.lost_streak_date := v_gap_day;
        v_streak.grace_period_expires_at := now() + interval '3 days';
        v_streak.current_streak := 0;
        v_gap_covered := false;
        EXIT;  -- streak is broken; remaining gap days are irrelevant
      END IF;
      v_gap_day := v_gap_day + 1;
    END LOOP;
  END IF;

  v_grace_active := v_streak.grace_period_expires_at IS NOT NULL
                    AND v_streak.grace_period_expires_at > now()
                    AND v_streak.lost_streak_value IS NOT NULL;

  v_prev_streak := v_streak.current_streak;

  IF v_grace_active AND p_is_premium THEN
    -- Restore: lost value + whatever was rebuilt since + today.
    -- Milestone baseline is the ORIGINAL streak value — thresholds the restored
    -- streak had already crossed were celebrated back then; don't re-fire them.
    v_prev_streak := GREATEST(v_streak.lost_streak_value, v_streak.current_streak);
    v_streak.current_streak := v_streak.lost_streak_value + v_streak.current_streak + 1;
    v_streak.streak_started_at := COALESCE(v_streak.streak_started_at, v_today);
    v_streak.lost_streak_value := NULL;
    v_streak.lost_streak_date := NULL;
    v_streak.grace_period_expires_at := NULL;
    v_today_status := 'restored';
    UPDATE streak_daily_log SET status = 'restored' WHERE user_id = p_user_id AND date = v_today;
  ELSIF v_streak.grace_period_expires_at IS NOT NULL AND NOT v_grace_active THEN
    -- Grace expired: clear it, then count normally
    v_streak.lost_streak_value := NULL;
    v_streak.lost_streak_date := NULL;
    v_streak.grace_period_expires_at := NULL;
    v_streak.current_streak := CASE
      WHEN v_streak.last_activity_date >= v_yesterday
        OR (v_streak.current_streak > 0 AND v_gap_covered)
      THEN v_streak.current_streak + 1
      ELSE 1 END;
    IF v_streak.current_streak = 1 THEN v_streak.streak_started_at := v_today; END IF;
  ELSIF v_streak.last_activity_date >= v_yesterday
        OR (v_streak.current_streak > 0 AND v_gap_covered) THEN
    -- Continuity from last_activity_date (NOT daily_log — seeded users have no history rows).
    -- '>=' also covers westward timezone moves where last_activity_date can equal today.
    -- The gap-covered case: the days since last activity were all frozen, so the
    -- streak survives (frozen days preserve continuity without counting).
    v_streak.current_streak := v_streak.current_streak + 1;
  ELSE
    -- Fresh start (free user in grace keeps grace fields: upgrading within window still restores)
    v_streak.current_streak := 1;
    v_streak.streak_started_at := v_today;
  END IF;

  v_streak.longest_streak := GREATEST(v_streak.longest_streak, v_streak.current_streak);
  v_streak.last_activity_date := v_today;

  UPDATE user_streaks SET
    current_streak = v_streak.current_streak,
    longest_streak = v_streak.longest_streak,
    last_activity_date = v_streak.last_activity_date,
    streak_started_at = v_streak.streak_started_at,
    freezes_available = v_streak.freezes_available,
    freezes_used_total = v_streak.freezes_used_total,
    lost_streak_value = v_streak.lost_streak_value,
    lost_streak_date = v_streak.lost_streak_date,
    grace_period_expires_at = v_streak.grace_period_expires_at
  WHERE user_id = p_user_id;

  -- Milestones: only thresholds crossed by this action (restore can cross several; take highest)
  FOREACH v_m IN ARRAY ARRAY[3, 7, 14, 30, 60, 90, 365] LOOP
    IF v_prev_streak < v_m AND v_streak.current_streak >= v_m THEN
      INSERT INTO streak_milestones (user_id, milestone, badge_type)
      VALUES (p_user_id, v_m, CASE WHEN v_m >= 60 THEN 'premium_exclusive' ELSE 'basic' END);
      v_new_milestone := v_m;
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'current_streak', v_streak.current_streak,
    'longest_streak', v_streak.longest_streak,
    'streak_incremented', true,
    'new_milestone', v_new_milestone,
    'today_status', v_today_status,
    'freezes_available', v_streak.freezes_available
  );
END;
$$ LANGUAGE plpgsql;

-- Verification
SELECT table_name FROM information_schema.tables
WHERE table_name IN ('user_streaks', 'streak_daily_log', 'streak_milestones');
