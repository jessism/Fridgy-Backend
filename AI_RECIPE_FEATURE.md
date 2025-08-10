# AI Recipe Recommendation Feature

## 🎯 Overview

The AI Recipe Recommendation feature uses Gemini 2.0 Flash and Fireworks AI to generate personalized recipes based on users' fridge inventory and dietary preferences, complete with professional food photography.

## 🏗️ Architecture

### Backend Services

**1. `aiRecipeService.js`**
- Uses Gemini 2.0 Flash via OpenRouter (reusing existing setup)
- Generates recipes based on exact inventory items and user preferences
- Implements intelligent caching with 24-hour expiration
- Cost: ~$0.00015 per generation (85% cheaper than Claude)

**2. `imageGenerationService.js`**
- Uses Fireworks AI with FLUX.1 dev model
- Generates professional food photography for each recipe
- Permanent image caching to avoid duplicate costs
- Cost: ~$0.005 per image

**3. `aiRecipeController.js`**
- RESTful API endpoints with JWT authentication
- Comprehensive error handling and logging
- Analytics tracking for optimization

### Database Schema

**Tables Created:**
- `ai_generated_recipes` - Caches complete recipe sets with 24h expiration
- `ai_recipe_images` - Permanent image cache with quality scoring
- `ai_recipe_analytics` - Usage analytics for cost optimization

### Frontend Components

**1. `useAIRecipes` Hook**
- State management for recipe generation
- Automatic caching and background updates
- Error handling and loading states

**2. `AIRecipeSection` Component**
- Main integration component for Meal Plans page
- Progressive loading with beautiful animations
- Cache-aware UI with regeneration options

**3. `AIRecipeCard` Component**
- Professional recipe card design
- Progressive image loading with skeletons
- Dietary badges and cooking metadata

## 🚀 API Endpoints

### Main Endpoints

```
POST /api/ai-recipes/generate
GET  /api/ai-recipes/cached  
DELETE /api/ai-recipes/cache
GET  /api/ai-recipes/analytics
GET  /api/ai-recipes/health
```

### Authentication
All endpoints require JWT authentication via `Authorization: Bearer <token>` header.

## 💰 Cost Analysis

### Per Generation (3 recipes + images):
- **Recipe generation**: $0.00015 (Gemini 2.0 Flash)
- **Image generation**: $0.015 (3 × $0.005 FLUX.1)
- **Total**: ~$0.0152 per generation

### With 24h Caching:
- **Cache hit rate**: Expected 60-80% for active users
- **Effective cost**: ~$0.003-$0.006 per generation
- **Monthly cost for 1,000 users**: ~$12-25

## 🛠️ Setup Instructions

### 1. Database Migration
Run the SQL migration to create required tables:
```sql
-- Execute: Backend/migrations/add_ai_recipes_schema.sql
```

### 2. Environment Variables
Add to your `.env` file:
```env
# Already configured
OPENROUTER_API_KEY=your-key-here

# New requirement  
FIREWORKS_API_KEY=your-fireworks-key-here
```

### 3. Get API Keys

**OpenRouter** (Already configured)
- Visit: https://openrouter.ai/
- Model used: `google/gemini-2.0-flash-001`

**Fireworks AI** (New)
- Visit: https://fireworks.ai/
- Model used: `flux-1-dev-fp8`
- Cost: $0.004-$0.006 per image

## 🎨 User Experience Flow

1. **User clicks "Generate Recipes"** on Meal Plans page
2. **System checks cache** - returns instantly if found
3. **AI analyzes inventory** + dietary preferences (2-3 seconds)
4. **Shows recipe cards** with loading placeholders for images  
5. **Images generate** in background and replace placeholders
6. **Result**: 3 beautiful recipe cards with professional photos

## 🔧 Technical Features

### Smart Caching
- **Content-based hashing** prevents duplicate generations
- **24-hour recipe cache** with automatic cleanup
- **Permanent image cache** across all users
- **Background updates** don't block user experience

### AI Optimization
- **Inventory prioritization** - uses items expiring sooner first
- **Dietary compliance** - respects all restrictions and allergies
- **Cooking time matching** - adapts to user preferences
- **Cuisine variety** - generates diverse recipe types

### Error Handling
- **Graceful degradation** with placeholder images
- **Comprehensive logging** for debugging
- **User-friendly errors** with retry mechanisms
- **Fallback prompts** if initial generation fails

## 📊 Analytics & Monitoring

### Built-in Analytics
- Generation times and success rates
- Cache hit ratios and cost tracking
- Error patterns and optimization opportunities
- User engagement metrics

### Health Monitoring
```bash
curl http://localhost:5000/api/ai-recipes/health
```

## 🔮 Future Enhancements

### Phase 2 Features
- **Recipe detail modal** integration
- **Save to favorites** functionality  
- **Cooking instructions** with step-by-step photos
- **Shopping list integration** for missing ingredients

### Phase 3 Features
- **Recipe ratings** and feedback learning
- **Seasonal recommendations** based on ingredient availability
- **Batch cooking** suggestions for meal prep
- **Nutritional analysis** with health insights

## 🧪 Testing

### Health Check
```bash
curl http://localhost:5000/api/ai-recipes/health
```

### Generate Test Recipes
```bash
curl -X POST http://localhost:5000/api/ai-recipes/generate \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -H "Content-Type: application/json"
```

### Check Cache
```bash
curl http://localhost:5000/api/ai-recipes/cached \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

## 🚨 Important Notes

1. **Database migration required** - run the SQL schema before first use
2. **Fireworks API key needed** - image generation will fail without it  
3. **User inventory required** - need items in fridge for recipe generation
4. **Dietary preferences optional** - but improve recipe quality when set

## 🎯 Success Metrics

- **User engagement**: Recipe generation frequency
- **Cost efficiency**: Cache hit rate >60%
- **Quality scores**: User satisfaction with generated recipes
- **Performance**: <3 second recipe generation, <10 second total with images

---

**Status**: ✅ Feature complete and ready for production
**Cost**: $0.0152 per generation (~85% cheaper than original plan)
**Performance**: Sub-3 second recipe generation with smart caching