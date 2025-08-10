-- Add questionnaire support to AI recipe system
-- This migration adds questionnaire data storage to enhance recipe personalization

-- Add questionnaire data column to ai_generated_recipes
ALTER TABLE ai_generated_recipes 
ADD COLUMN questionnaire_data JSONB DEFAULT '{}';

-- Add index for better query performance on questionnaire data
CREATE INDEX idx_ai_generated_recipes_questionnaire 
ON ai_generated_recipes USING gin (questionnaire_data);

-- Create index for combined user_id + questionnaire data queries
CREATE INDEX idx_ai_generated_recipes_user_questionnaire 
ON ai_generated_recipes (user_id, questionnaire_data);

-- Add comments for documentation
COMMENT ON COLUMN ai_generated_recipes.questionnaire_data IS 'JSON data containing user responses from the recipe questionnaire including meal_type, cooking_time, vibe, cuisine_preference, and additional_notes';

-- Example questionnaire_data structure:
-- {
--   "meal_type": "dinner",
--   "cooking_time": "30_minutes", 
--   "vibe": "comfort_food",
--   "cuisine_preference": "italian",
--   "dietary_considerations": ["low_carb"],
--   "additional_notes": "craving something cheesy and warm"
-- }