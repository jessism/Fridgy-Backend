# Recipe Tags Implementation Guide

## Overview
This document describes the recipe tagging feature implementation, including database schema, API changes, and deployment instructions.

## Files Created/Modified

### New Files
1. **`migrations/058_add_recipe_tags.sql`** - Database migration for tags column
2. **`services/recipeTagService.js`** - AI tag generation logic
3. **`scripts/backfillRecipeTags.js`** - Script to tag existing recipes

### Modified Files
1. **`routes/savedRecipes.js`**
   - Added `generateRecipeTags` import
   - POST endpoint now generates AI tags on recipe creation
   - PUT endpoint accepts tags field for updates
   - PATCH endpoint already supported tags

## Deployment Instructions

### Step 1: Run Database Migration

Apply the migration to add the `tags` column to the `saved_recipes` table:

```bash
# Option A: Via Supabase Dashboard
# 1. Go to SQL Editor in Supabase Dashboard
# 2. Copy contents of migrations/058_add_recipe_tags.sql
# 3. Run the query

# Option B: Via Supabase CLI (if configured)
supabase db push
```

Verify the migration:
```sql
-- Check if column exists
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = 'saved_recipes' AND column_name = 'tags';

-- Check if index exists
SELECT indexname
FROM pg_indexes
WHERE tablename = 'saved_recipes' AND indexname = 'idx_saved_recipes_tags';
```

### Step 2: Deploy Backend Code

Push the updated code to Railway (or your hosting platform):

```bash
cd /Users/jessie/fridgy/Backend
git add .
git commit -m "Add recipe tagging feature with AI generation

- Add tags JSONB column to saved_recipes table
- Implement AI tag generation service (36 predefined tags)
- Update POST endpoint to auto-generate tags
- Update PUT/PATCH endpoints to accept tags
- Add backfill script for existing recipes"
git push
```

Railway will automatically deploy the changes.

### Step 3: Backfill Existing Recipes (Optional)

Generate tags for all existing recipes:

```bash
cd /Users/jessie/fridgy/Backend
node scripts/backfillRecipeTags.js
```

**Note:** This script:
- Processes recipes without tags
- Generates 1-3 AI tags per recipe
- Includes rate limiting (100ms between updates)
- Logs progress and errors
- Can be run multiple times safely

## Tag Generation Logic

### AI Tag Categories (36 Total)

- **Dietary (8)**: Vegetarian, Vegan, Keto, Paleo, Gluten-Free, Dairy-Free, Low Carb, High Protein
- **Meal Type (6)**: Breakfast, Lunch, Dinner, Snack, Dessert, Appetizer
- **Speed (2)**: Quick (< 30 min), Easy
- **Protein (5)**: Chicken, Beef, Seafood, Pork, Plant-Based
- **Cuisine (8)**: Italian, Mexican, Asian, Mediterranean, American, Indian, French, Thai
- **Occasion (5)**: Weeknight, Weekend, Meal Prep, Party, Holiday

### Tag Generation Algorithm

Tags are generated based on:

1. **Dietary Flags** (Priority 1)
   - `vegetarian: true` → "Vegetarian"
   - `vegan: true` → "Vegan" + "Vegetarian"
   - `glutenFree: true` → "Gluten-Free"
   - `dairyFree: true` → "Dairy-Free"

2. **Cook Time** (Priority 2)
   - `readyInMinutes < 30` → "Quick"

3. **Nutrition** (Priority 3)
   - `percentProtein ≥ 30%` → "High Protein"
   - `percentFat ≥ 60% AND percentCarbs < 10%` → "Keto"
   - `percentCarbs < 20%` → "Low Carb"

4. **Ingredients** (Priority 4)
   - Detects protein types: chicken, beef, seafood, pork, plant-based

5. **Title/Description** (Priority 5)
   - Keyword matching for cuisines: Italian, Mexican, Asian, etc.

6. **Meal Type** (Priority 6)
   - Keyword matching in title: breakfast, dessert, appetizer, snack

**Max Tags:** 3 AI-generated tags per recipe

## API Endpoints

### POST /api/saved-recipes
Creates a new recipe with AI-generated tags.

**Request:**
```json
{
  "title": "Chicken Stir Fry",
  "summary": "Quick Asian-inspired dish",
  "extendedIngredients": [...],
  "readyInMinutes": 25,
  "nutrition": {
    "caloricBreakdown": {
      "percentProtein": 35,
      "percentCarbs": 30,
      "percentFat": 35
    }
  }
}
```

**Response:**
```json
{
  "success": true,
  "recipe": {
    "id": "...",
    "title": "Chicken Stir Fry",
    "tags": [
      {"id": "tag_quick", "name": "Quick", "category": "speed", "is_custom": false},
      {"id": "tag_chicken", "name": "Chicken", "category": "protein", "is_custom": false},
      {"id": "tag_asian", "name": "Asian", "category": "cuisine", "is_custom": false}
    ],
    ...
  }
}
```

### PUT /api/saved-recipes/:id
Updates a recipe. Can update tags manually.

**Request:**
```json
{
  "tags": [
    {"id": "tag_keto", "name": "Keto", "category": "dietary", "is_custom": false},
    {"id": "custom_spicy", "name": "Spicy", "category": "custom", "is_custom": true}
  ]
}
```

### GET /api/saved-recipes
Returns all user recipes with tags included.

### GET /api/saved-recipes/:id
Returns single recipe with tags.

## Tag Data Structure

```typescript
interface RecipeTag {
  id: string;              // e.g., "tag_vegetarian" or "custom_spicy"
  name: string;            // e.g., "Vegetarian" or "Spicy"
  category: TagCategory;   // dietary, meal_type, speed, protein, cuisine, occasion, custom
  is_custom: boolean;      // false for predefined, true for user-created
}
```

Stored as JSONB array in database:
```json
[
  {"id": "tag_vegetarian", "name": "Vegetarian", "category": "dietary", "is_custom": false},
  {"id": "tag_quick", "name": "Quick", "category": "speed", "is_custom": false},
  {"id": "custom_family_favorite", "name": "Family Favorite", "category": "custom", "is_custom": true}
]
```

## Testing

### Manual API Testing

```bash
# Get auth token
TOKEN="your_jwt_token_here"
BASE_URL="https://fridgy-backend-production.up.railway.app/api"

# Test GET (should include tags)
curl -H "Authorization: Bearer $TOKEN" \
  "$BASE_URL/saved-recipes"

# Test POST (should auto-generate tags)
curl -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Vegan Pasta",
    "extendedIngredients": [{"name": "pasta"}, {"name": "tofu"}],
    "vegan": true,
    "readyInMinutes": 20
  }' \
  "$BASE_URL/saved-recipes"

# Test PUT (should accept custom tags)
curl -X PUT \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "tags": [
      {"id": "tag_vegan", "name": "Vegan", "category": "dietary", "is_custom": false},
      {"id": "custom_comfort", "name": "Comfort Food", "category": "custom", "is_custom": true}
    ]
  }' \
  "$BASE_URL/saved-recipes/RECIPE_ID"
```

### Expected Results

1. **New recipes**: Should have 1-3 AI-generated tags
2. **Existing recipes** (after backfill): Should have tags
3. **Manual updates**: User can add/remove/modify tags
4. **Tag filtering**: Frontend can filter recipes by tags

## Troubleshooting

### Tags not generating
- Check if recipe has required fields (ingredients, nutrition, title)
- Verify tag service logs in backend
- Ensure migration ran successfully

### Backfill script errors
- Verify `SUPABASE_SERVICE_KEY` is set in .env
- Check database connection
- Review error logs for specific recipes

### Tags not updating
- Verify 'tags' is in allowedFields for PUT/PATCH endpoints
- Check request payload includes tags field
- Verify authentication token is valid

## Future Enhancements

- Tag analytics (most popular tags)
- Tag-based recipe recommendations
- Bulk tag operations
- Tag synonyms and smart matching
- User tag preferences

## Support

For issues or questions:
1. Check backend logs in Railway dashboard
2. Review Supabase logs for database errors
3. Test API endpoints with curl/Postman
4. Verify migration was applied correctly
