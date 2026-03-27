-- Migration: Fix duplicate push notifications
-- Problem: Same expo_token can be registered for multiple users, causing duplicate notifications
-- Solution: Change constraint from UNIQUE(user_id, expo_token) to UNIQUE(expo_token)

BEGIN;

-- 1. Drop old constraint allowing same token for multiple users
ALTER TABLE mobile_push_tokens
DROP CONSTRAINT IF EXISTS mobile_push_tokens_user_id_expo_token_key;

-- 2. Clean up duplicates FIRST (keep most recent per token)
WITH duplicates AS (
  SELECT expo_token, id,
         ROW_NUMBER() OVER (PARTITION BY expo_token ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST) as rn
  FROM mobile_push_tokens
)
DELETE FROM mobile_push_tokens
WHERE id IN (SELECT id FROM duplicates WHERE rn > 1);

-- 3. THEN add new unique constraint (one token = one user)
ALTER TABLE mobile_push_tokens
ADD CONSTRAINT mobile_push_tokens_expo_token_key UNIQUE (expo_token);

COMMIT;
