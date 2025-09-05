-- Create table to track user-specific ingredient matching preferences
-- This helps the system learn and improve matching accuracy over time

CREATE TABLE IF NOT EXISTS user_ingredient_matches (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  scanned_name VARCHAR(255) NOT NULL,
  matched_item_name VARCHAR(255) NOT NULL,
  confidence_score INTEGER DEFAULT 50,
  match_count INTEGER DEFAULT 1,
  last_used TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  
  -- Unique constraint to prevent duplicate entries
  UNIQUE(user_id, scanned_name, matched_item_name)
);

-- Index for fast lookups
CREATE INDEX idx_user_matches_lookup ON user_ingredient_matches(user_id, scanned_name);
CREATE INDEX idx_user_matches_confidence ON user_ingredient_matches(confidence_score DESC);

-- Trigger to update the updated_at timestamp
CREATE OR REPLACE FUNCTION update_user_matches_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_user_ingredient_matches_updated_at 
BEFORE UPDATE ON user_ingredient_matches 
FOR EACH ROW 
EXECUTE FUNCTION update_user_matches_updated_at();

-- Sample query to get user's preferred match:
-- SELECT matched_item_name, confidence_score 
-- FROM user_ingredient_matches 
-- WHERE user_id = ? AND scanned_name = ?
-- ORDER BY confidence_score DESC, match_count DESC 
-- LIMIT 1;