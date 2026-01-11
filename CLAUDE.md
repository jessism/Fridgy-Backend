# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Fridgy Backend is an Express.js API server for an AI-powered fridge inventory management app. It handles food item recognition via AI, recipe extraction from social media, meal planning, shopping lists, inventory tracking, and integrations with external services (Instagram, Facebook, Google Drive, Stripe).

## Development Commands

### Running the Server
```bash
npm install              # Install dependencies
npm start               # Start production server
npm run dev             # Start development server with nodemon (auto-reload)
```

### Testing & Debugging
```bash
# Run individual test scripts (no formal test framework)
node test-ai-extraction.js           # Test AI food recognition
node test-instagram-import.js        # Test Instagram recipe import
node test-nutrition-analysis.js      # Test nutrition analysis
node test-spoonacular-api.js         # Test Spoonacular API integration
```

### Utility Scripts
```bash
node generate-vapid-keys.js          # Generate VAPID keys for push notifications
node run-migration.js                # Run database migrations
node debug_user_tier.js              # Debug user subscription tiers
node fix_tier_sync.js                # Fix tier synchronization issues
```

## Architecture Overview

### Layered Architecture
The backend follows a **controller → service → database** pattern:

1. **Routes** (`/routes/*.js`) - Define API endpoints, apply middleware, delegate to controllers
2. **Controllers** (`/controller/*.js`) - Handle HTTP requests/responses, validate input, call services
3. **Services** (`/services/*.js`) - Contain business logic, interact with external APIs and database
4. **Middleware** (`/middleware/*.js`) - Authentication, rate limiting, usage limits, validation
5. **Config** (`/config/*.js`) - Database connections, Supabase clients, PostHog analytics

### Key Architectural Patterns

#### Supabase Client Pattern
The codebase uses **two types of Supabase clients** with different permission levels:

- **Anon Client** (`getAnonClient()`) - Respects Row Level Security (RLS), used for user-scoped operations
- **Service Client** (`getServiceClient()`) - Bypasses RLS, used for admin operations and cross-user queries

Import from: `const { getServiceClient, getAnonClient } = require('../config/supabase')`

**When to use which:**
- Use `getServiceClient()` for: admin operations, cross-user analytics, scheduled jobs, webhook handlers
- Use `getAnonClient()` for: user-specific data access respecting RLS policies

#### AI Service Architecture
The backend integrates multiple AI providers with **tiered fallback strategies**:

**Primary AI Services:**
- **Gemini 2.0 Flash** (via OpenRouter) - Food recognition from photos, recipe extraction
- **Google Gemini API** (direct) - Video analysis for recipe reels
- **Spoonacular API** - Recipe database lookups (optional, feature-flagged)

**Key AI Classes:**
- `RecipeAIExtractor` - Extracts recipes from web URLs, handles AI fallbacks
- `MultiModalExtractor` - Analyzes Instagram videos/images for recipes (Gemini video → OpenRouter fallback)
- `ProgressiveExtractor` - Tiered extraction (text-only → with images → with video)
- `NutritionAnalysisService` - Analyzes meal nutrition from photos

**AI Fallback Chain Example** (Multi-Modal Extraction):
1. Try Google Gemini direct video API (fastest, best quality)
2. Fall back to OpenRouter + video frame extraction
3. Fall back to caption + images only

#### Authentication Flow
```
Request → authMiddleware.authenticateToken → JWT verification → User lookup in Supabase → req.user populated
```

JWT token contains: `{ userId, email }`
Retrieved user object: `{ id, email, firstName }`

#### Rate Limiting & Usage Tracking
Middleware chain for protected features:
```javascript
router.post('/endpoint',
  authMiddleware.authenticateToken,      // Verify user identity
  checkImportedRecipeLimit,              // Check if user hit daily limits
  async (req, res) => { ... }
);
```

Usage tracking is handled by:
- `checkLimits.js` - Checks subscription tier limits before execution
- `incrementUsageCounter()` - Records successful feature usage
- Database table `user_subscription_metadata` stores usage counters

### Social Media Recipe Import Pipeline

**Instagram Import Flow:**
1. User provides Instagram post URL
2. `ApifyInstagramService` scrapes post data (caption, images, video URL)
3. `MultiModalExtractor` analyzes content via AI
4. Recipe data formatted to Spoonacular-compatible schema
5. Saved to `saved_recipes` table with user association

**Facebook Import Flow:**
1. Similar to Instagram but uses `ApifyFacebookService`
2. Handles Facebook-specific URL patterns and metadata

**Critical Note:** Apify video URLs expire after ~1 hour. The system checks `videoUrlExpiry` timestamp and falls back to images if expired.

### Recipe Data Schema
Recipes are stored in Spoonacular-compatible format:

```javascript
{
  title: string,
  summary: string,
  image: string,  // URL to recipe photo
  extendedIngredients: [
    {
      original: string,      // "2 cups flour"
      name: string,          // "flour"
      amount: number,        // 2
      unit: string          // "cups"
    }
  ],
  analyzedInstructions: [
    {
      name: string,
      steps: [
        { number: 1, step: string }
      ]
    }
  ],
  readyInMinutes: number,
  servings: number,
  vegetarian: boolean,
  vegan: boolean,
  glutenFree: boolean,
  dairyFree: boolean
}
```

### Inventory & Meal Tracking

**Inventory Deduction System:**
- When a meal is logged, `inventoryDeductionService.js` automatically deducts ingredients from fridge inventory
- Uses **weight-based unit conversion** - tracks both pieces and total weight in ounces
- Smart matching algorithm normalizes ingredient names (e.g., "chicken breast" matches "chicken")
- Weight estimation during grocery scanning enables accurate deductions (1 chicken breast = 6 oz)

**Smart Weight Tracking:**
- AI estimates weights during grocery scanning using built-in reference table
- Database stores both `quantity` (pieces) and `total_weight_oz`
- Deduction calculates pieces needed from recipe's ounce requirement
- See `SMART_DEDUCTION_SYSTEM.md` for detailed implementation

### External Integrations

**Stripe Subscriptions:**
- Webhook endpoint at `/api/webhooks` processes subscription events
- **Critical:** Webhook route must be registered BEFORE `express.json()` middleware (requires raw body for signature verification)
- `stripeService.js` and `subscriptionService.js` handle tier management
- User tiers stored in `user_subscription_metadata.subscription_tier`

**Push Notifications:**
- Uses `web-push` library with VAPID keys
- Scheduled via `expiryNotificationScheduler.js` (checks expiring items daily)
- Subscription endpoint: `/api/push/subscribe`

**Google Integrations:**
- Google Calendar sync for meal planning (`googleCalendarService.js`)
- Google Drive export for cookbooks (`googleDriveService.js`)

**Messaging Bots:**
- Instagram DM bot (`instagramDMBot.js`) - Recipe suggestions via DM
- Messenger bot (`messengerBot.js`) - Facebook Messenger integration

### Database Schema Highlights

**Primary Tables:**
- `users` - User accounts (id, email, password_hash, first_name)
- `fridge_items` - Inventory items (user_id, item_name, quantity, expiration_date, category, total_weight_oz)
- `saved_recipes` - User's saved recipes
- `meal_history` - Logged meals for tracking
- `shopping_lists` - Shopping list items
- `user_subscription_metadata` - Subscription tiers, usage limits, counters

**Subscription Tiers:**
- Free tier: 5 recipe imports per day
- Pro tier: Unlimited recipe imports, advanced features
- Tier logic handled by `checkLimits.js` middleware

## Environment Variables

### Required Variables
```bash
# Supabase (required for all database operations)
SUPABASE_URL=your_supabase_url
SUPABASE_ANON_KEY=your_supabase_anon_key
SUPABASE_SERVICE_KEY=your_supabase_service_role_key  # For admin operations

# Authentication
JWT_SECRET=your_jwt_secret_key

# AI Services (at least one required for AI features)
OPENROUTER_API_KEY=your_openrouter_api_key           # For Gemini via OpenRouter
GOOGLE_GEMINI_API_KEY=your_google_gemini_api_key    # For direct Gemini video analysis

# Recipe Import
APIFY_API_TOKEN=your_apify_api_token                 # Instagram/Facebook scraping
```

### Optional Variables
```bash
# Recipe Database
SPOONACULAR_API_KEY=your_spoonacular_api_key
ENABLE_SPOONACULAR_RECIPES=false                     # Feature flag to disable API calls

# Payments
STRIPE_SECRET_KEY=your_stripe_secret_key
STRIPE_WEBHOOK_SECRET=your_stripe_webhook_secret

# Push Notifications
VAPID_PUBLIC_KEY=your_vapid_public_key
VAPID_PRIVATE_KEY=your_vapid_private_key

# Analytics
POSTHOG_API_KEY=your_posthog_api_key

# Image Generation
FIREWORKS_API_KEY=your_fireworks_api_key             # For recipe image generation

# CORS
FRONTEND_URL=http://localhost:3000                    # Allow list for CORS
```

## CORS Configuration

The server uses dynamic CORS with allow lists for:
- `localhost:3000`, `localhost:3001` (development)
- `trackabite.vercel.app`, `trackabite.app`, `www.trackabite.app` (production)
- Any `.ngrok-free.app` domain (testing)
- Any `.vercel.app` domain (preview deployments)

Additional origins can be added via `FRONTEND_URL` environment variable.

## Common Patterns & Best Practices

### AI Prompt Engineering
When modifying AI extraction prompts, always:
- **Be explicit with JSON schema** - Include exact field names and structure
- **Provide examples** - Show expected output format
- **Handle fractions** - RecipeAIExtractor has `sanitizeFractions()` utility for recipe amounts
- **Set temperature low** (0.1-0.3) for structured extraction tasks

Example from `multiModalExtractor.js`:
```javascript
// Always specify exact JSON structure
const prompt = `Return ONLY a JSON object with this EXACT structure:
{
  "title": "Recipe Name",
  "ingredients": [...],
  ...
}`;
```

### Error Handling for External APIs
Always implement fallback strategies for external API calls:

```javascript
try {
  // Try primary API
  const result = await primaryAPI.call();
} catch (error) {
  if (error.status === 429) {
    // Rate limited - try fallback
    const result = await fallbackAPI.call();
  } else {
    // Log and return graceful error
    console.error('[Service] API error:', error);
    throw new Error('User-friendly message');
  }
}
```

### Logging Convention
Use prefixed console logs for easier debugging:
```javascript
console.log('[ServiceName] Description:', data);
console.error('[ServiceName] Error:', error);
```

Common prefixes:
- `[RecipeImport]` - Recipe import flow
- `[MultiModal]` - Multi-modal AI extraction
- `[Auth]` - Authentication
- `[Stripe]` - Stripe webhooks/subscriptions

### Request ID Tracking
Long-running AI operations use request IDs for log correlation:
```javascript
const requestId = Math.random().toString(36).substring(7);
console.log(`[${requestId}] Step 1: Processing...`);
```

### Image Upload Pattern
Recipe images are uploaded to Supabase Storage bucket `recipe-images`:

```javascript
const fileName = `${userId}/${timestamp}_${randomId}_recipe.jpg`;
const { data, error } = await supabase.storage
  .from('recipe-images')
  .upload(fileName, buffer, { contentType: 'image/jpeg' });

const { data: urlData } = supabase.storage
  .from('recipe-images')
  .getPublicUrl(fileName);
```

## Deployment

### Railway Configuration
- Deployment configured via `nixpacks.toml` and `railway.json`
- Uses Node.js buildpack with automatic detection
- Environment variables must be set in Railway dashboard

### Production Checklist
- [ ] Set `NODE_ENV=production`
- [ ] Configure `SUPABASE_SERVICE_KEY` (not just anon key)
- [ ] Set strong `JWT_SECRET` (not default value)
- [ ] Configure `FRONTEND_URL` for CORS
- [ ] Set up Stripe webhook URL in Stripe dashboard
- [ ] Generate and configure VAPID keys for push notifications
- [ ] Set `ENABLE_SPOONACULAR_RECIPES=false` if avoiding API costs

## Key Routes Reference

### Authentication
- `POST /api/auth/signup` - User registration
- `POST /api/auth/login` - User login (returns JWT)
- `POST /api/auth/logout` - User logout

### Inventory
- `GET /api/inventory` - Get user's fridge items
- `POST /api/inventory` - Add fridge items
- `PUT /api/inventory/:id` - Update fridge item
- `DELETE /api/inventory/:id` - Remove fridge item
- `POST /api/process-images` - AI food recognition from photos

### Recipes
- `POST /api/recipes/import-instagram` - Import recipe from Instagram URL
- `POST /api/recipes/multi-modal-extract` - Multi-modal recipe extraction
- `POST /api/scan-recipe` - Scan recipe from photo (supports multi-page)
- `GET /api/recipes/suggestions` - Get recipe suggestions (Spoonacular)
- `POST /api/saved-recipes` - Save recipe to user's collection
- `GET /api/saved-recipes` - Get user's saved recipes

### Meal Planning
- `GET /api/meal-plans` - Get meal plans
- `POST /api/meal-plans` - Create meal plan
- `POST /api/meals` - Log a consumed meal (triggers inventory deduction)

### Shopping Lists
- `GET /api/shopping-lists` - Get shopping lists
- `POST /api/shopping-lists` - Create shopping list
- `POST /api/shopping-lists/:id/items` - Add items to list

### Subscriptions
- `GET /api/subscriptions/status` - Get user's subscription status
- `POST /api/subscriptions/create-checkout-session` - Create Stripe checkout
- `POST /api/webhooks` - Stripe webhook handler (raw body required)

### Push Notifications
- `POST /api/push/subscribe` - Subscribe to push notifications
- `POST /api/push/unsubscribe` - Unsubscribe from notifications

## Debugging Tips

### Common Issues

**"AI_PROCESSING_FAILED" errors:**
- Check `OPENROUTER_API_KEY` is set and starts with `sk-or-v1`
- Check API health: `GET /api/health/ai`
- Review console logs for detailed AI request/response tracking

**Stripe webhook failures:**
- Verify webhook route is BEFORE `express.json()` in `server.js` (line 96)
- Check `STRIPE_WEBHOOK_SECRET` matches Stripe dashboard
- Test webhook locally with Stripe CLI: `stripe listen --forward-to localhost:5000/api/webhooks`

**Supabase RLS errors:**
- Ensure using `getServiceClient()` for admin operations
- Check if `SUPABASE_SERVICE_KEY` is configured (not just anon key)
- Review RLS policies in Supabase dashboard

**Instagram/Facebook import failures:**
- Check `APIFY_API_TOKEN` is valid
- Verify post URL is public (not private account)
- Check Apify run status in console logs
- Video URLs expire after 1 hour - system should fallback to images

**Rate limit errors (429):**
- Free Gemini model has rate limits - system auto-falls back to paid models
- Spoonacular API has daily limits - use `ENABLE_SPOONACULAR_RECIPES=false` to disable

### Testing AI Extraction Locally
```bash
# Test grocery recognition
node test-ai-extraction.js

# Test Instagram import with real URL
node test-instagram-import.js

# Test recipe extraction from web URL
node test-spoonacular-api.js
```

## Related Documentation

For frontend implementation details, see `/Frontend/CLAUDE.md` (if it exists).

For smart deduction system details, see `SMART_DEDUCTION_SYSTEM.md` in the Backend directory.
