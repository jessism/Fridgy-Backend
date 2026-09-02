/**
 * Maps an authenticated API request to a product feature + action for
 * analytics (PostHog `feature_used`). One event name with a `feature`
 * property so "most used feature" is a single trend broken down by feature.
 *
 * Returns null for requests that should not count as feature usage:
 * health checks, polling endpoints, auth plumbing, webhooks, admin tooling.
 */

// Routes that are polled or purely infrastructural — never count these.
const SKIP = [
  /^[A-Z]+ \/api\/admin\//,                     // admin tooling is not product usage
  /^GET \/api\/health/,
  /^GET \/api\/app-version/,
  /^GET \/api\/proxy-image/,
  /^GET \/api\/[^/]+\/health/,
  /^GET \/api\/recipes\/import-status\//,     // import polling
  /^GET \/api\/ai-recipes\/cached/,           // cache check on screen load
  /^GET \/api\/[a-z-]+\/apify-usage/,         // quota check
  /^POST \/api\/auth\/refresh/,
  /^POST \/api\/auth\/logout/,
  /^GET \/api\/auth\/me/,
  /^GET \/api\/auth\/deletion-status/,
  /^GET \/api\/subscriptions\/(price|status|debug)/,
  /^GET \/api\/push\/vapid-public-key/,
  /^(GET|POST) \/api\/push\/(test|check-subscription)/,
  /^GET \/api\/(messenger|instagram-dm)\/webhook/,
  /^POST \/api\/(messenger|instagram-dm)\/webhook/,
  /^GET \/api\/calendar\/(callback|ics)/,
  /^GET \/api\/drive\/callback/,
  /^GET \/api\/shopping-lists\/(public|join-page)\//, // logged-out share pages
  /^GET \/api\/saved-recipes\/[^/]+\/public/,
  /^GET \/api\/streaks$/,                     // fetched on every home load
  /^GET \/api\/streaks\/milestones/,
  /^GET \/api\/user-preferences/,
  /^GET \/api\/ingredient-images/,
  /^POST \/api\/ingredient-images\/batch-match/,
  /^GET \/api\/tts\/voices/,
  /^GET \/api\/voice-tts\/voices/,
  /^POST \/api\/voice-tts\/prewarm/,
  /^(GET|POST|PUT|DELETE) \/api\/(tiktok-upload|blog)/, // admin tooling
  /^GET \/api\/inventory-analytics\/debug/,
];

// Ordered: first match wins. `action` may be a string or a function of the
// route pattern match. Anything not matched falls through to a generic
// (feature by base path, action by HTTP method) rule.
const RULES = [
  // --- inventory
  { re: /^POST \/api\/inventory$/, feature: 'inventory', action: 'add_items' },
  { re: /^GET \/api\/inventory\/validate-servings/, feature: 'inventory', action: 'validate_servings' },
  { re: /^GET \/api\/inventory$/, feature: 'inventory', action: 'view' },
  { re: /^PUT \/api\/inventory\//, feature: 'inventory', action: 'update_item' },
  { re: /^DELETE \/api\/inventory\//, feature: 'inventory', action: 'delete_item' },
  { re: /^POST \/api\/scan-recipe/, feature: 'recipe_import', action: 'scan_photo' },
  { re: /^GET \/api\/inventory-analytics\/usage/, feature: 'inventory_usage', action: 'view' },
  { re: /^GET \/api\/insights/, feature: 'insights', action: 'view' }, // new Insights screen (mobile)

  // --- meals
  { re: /^POST \/api\/meals\/scan/, feature: 'meal_log', action: 'scan' },
  { re: /^POST \/api\/meals\/log/, feature: 'meal_log', action: 'log' },
  { re: /^POST \/api\/meals\/dine-out/, feature: 'meal_log', action: 'log_dine_out' },
  { re: /^GET \/api\/meals\/(history|calendar-summary)/, feature: 'meal_log', action: 'view' },
  { re: /^PUT \/api\/meals\//, feature: 'meal_log', action: 'update' },
  { re: /^DELETE \/api\/meals\//, feature: 'meal_log', action: 'delete' },

  // --- recipe import (social / web / voice)
  { re: /^POST \/api\/recipes\/import-(instagram|async|web|instagram-apify)/, feature: 'recipe_import', action: 'import' },
  { re: /^POST \/api\/(recipes|facebook-recipes|youtube-recipes|tiktok-recipes)\/multi-modal-extract/, feature: 'recipe_import', action: 'import' },
  { re: /^POST \/api\/recipes\/create-from-voice/, feature: 'recipe_import', action: 'create_from_voice' },
  { re: /^POST \/api\/recipes\/upload-image/, feature: 'recipe_import', action: 'upload_image' },
  { re: /^POST \/api\/shortcuts\/import/, feature: 'recipe_import', action: 'ios_shortcut' },
  { re: /^(GET|POST) \/api\/shortcuts/, feature: 'recipe_import', action: 'shortcut_setup' },
  { re: /^(GET|POST) \/api\/recipes\/suggestions/, feature: 'recipes', action: 'suggestions' },
  { re: /^GET \/api\/recipes\/curated/, feature: 'recipes', action: 'browse_curated' },
  { re: /^POST \/api\/recipes\/save/, feature: 'saved_recipes', action: 'save' },
  { re: /^POST \/api\/recipes\/[^/]+\/cook/, feature: 'cooking', action: 'cook' },
  { re: /^GET \/api\/recipes\//, feature: 'recipes', action: 'view_recipe' },

  // --- saved recipes / collections
  { re: /^POST \/api\/saved-recipes\/from-ai/, feature: 'saved_recipes', action: 'save_from_ai' },
  { re: /^POST \/api\/saved-recipes\/[^/]+\/favorite/, feature: 'saved_recipes', action: 'favorite' },
  { re: /^POST \/api\/saved-recipes\/[^/]+\/cook/, feature: 'cooking', action: 'cook' },
  { re: /^POST \/api\/cook-events/, feature: 'cooking', action: 'cook_complete' }, // mobile Cooking Mode ✓
  { re: /^(GET|POST) \/api\/saved-recipes\/collections/, feature: 'saved_recipes', action: 'collections' },
  { re: /^POST \/api\/saved-recipes\/[^/]+\/collections\//, feature: 'saved_recipes', action: 'add_to_collection' },
  { re: /^POST \/api\/saved-recipes$/, feature: 'saved_recipes', action: 'save' },
  { re: /^GET \/api\/saved-recipes$/, feature: 'saved_recipes', action: 'view_list' },
  { re: /^GET \/api\/saved-recipes\//, feature: 'saved_recipes', action: 'view_recipe' },
  { re: /^(PUT|PATCH) \/api\/saved-recipes\//, feature: 'saved_recipes', action: 'edit' },
  { re: /^DELETE \/api\/saved-recipes\//, feature: 'saved_recipes', action: 'delete' },

  // --- AI
  { re: /^POST \/api\/ai-recipes\/generate/, feature: 'ai_recipes', action: 'generate' },
  { re: /^GET \/api\/ai-recipes\/history/, feature: 'ai_recipes', action: 'view_history' },
  { re: /^DELETE \/api\/ai-recipes/, feature: 'ai_recipes', action: 'delete' },
  { re: /^POST \/api\/ai-chef\/ask/, feature: 'ai_chef', action: 'ask' },
  { re: /^POST \/api\/ai-chef\/transcribe/, feature: 'ai_chef', action: 'transcribe' },

  // --- voice cooking
  { re: /^POST \/api\/voice-tts\/speak/, feature: 'voice_cooking', action: 'speak' },
  { re: /^GET \/api\/voice-tts\/preview/, feature: 'voice_cooking', action: 'preview_voice' },
  { re: /^POST \/api\/tts/, feature: 'voice_cooking', action: 'speak' },

  // --- shopping lists
  { re: /^POST \/api\/shopping-lists\/[^/]+\/items\/[^/]+\/toggle/, feature: 'shopping_list', action: 'toggle_item' },
  { re: /^POST \/api\/shopping-lists\/[^/]+\/items/, feature: 'shopping_list', action: 'add_items' },
  { re: /^(PUT|DELETE) \/api\/shopping-lists\/[^/]+\/items/, feature: 'shopping_list', action: 'edit_items' },
  { re: /^POST \/api\/shopping-lists\/[^/]+\/share/, feature: 'shopping_list', action: 'share' },
  { re: /^GET \/api\/shopping-lists\/join\//, feature: 'shopping_list', action: 'join' },
  { re: /^POST \/api\/shopping-lists\/[^/]+\/purchase-to-inventory/, feature: 'shopping_list', action: 'purchase_to_inventory' },
  { re: /^POST \/api\/shopping-lists\/[^/]+\/add-recipe/, feature: 'shopping_list', action: 'add_recipe' },
  { re: /^POST \/api\/shopping-lists\/[^/]+\/clear-completed/, feature: 'shopping_list', action: 'clear_completed' },
  { re: /^POST \/api\/shopping-lists\/categorize/, feature: 'shopping_list', action: 'categorize' },
  { re: /^POST \/api\/shopping-lists\/migrate/, feature: 'shopping_list', action: 'migrate' },
  { re: /^POST \/api\/shopping-lists$/, feature: 'shopping_list', action: 'create_list' },
  { re: /^GET \/api\/shopping-lists\/[^/]+\/activities/, feature: 'shopping_list', action: 'view_activity' },
  { re: /^GET \/api\/shopping-lists/, feature: 'shopping_list', action: 'view' },
  { re: /^PUT \/api\/shopping-lists\//, feature: 'shopping_list', action: 'edit_list' },
  { re: /^DELETE \/api\/shopping-lists\//, feature: 'shopping_list', action: 'delete_list' },

  // --- meal plans / calendar
  { re: /^POST \/api\/meal-plans\/generate-grocery-list/, feature: 'meal_plan', action: 'generate_grocery_list' },
  { re: /^POST \/api\/meal-plans\/[^/]+\/complete/, feature: 'meal_plan', action: 'complete' },
  { re: /^POST \/api\/meal-plans$/, feature: 'meal_plan', action: 'add' },
  { re: /^GET \/api\/meal-plans/, feature: 'meal_plan', action: 'view' },
  { re: /^PUT \/api\/meal-plans\//, feature: 'meal_plan', action: 'edit' },
  { re: /^DELETE \/api\/meal-plans\//, feature: 'meal_plan', action: 'remove' },
  { re: /^GET \/api\/calendar\/(status|preferences)/, feature: 'calendar_sync', action: 'view' },
  { re: /^[A-Z]+ \/api\/calendar/, feature: 'calendar_sync', action: 'sync' },

  // --- cookbooks
  { re: /^POST \/api\/cookbooks\/[^/]+\/recipes/, feature: 'cookbook', action: 'add_recipe' },
  { re: /^DELETE \/api\/cookbooks\/[^/]+\/recipes/, feature: 'cookbook', action: 'remove_recipe' },
  { re: /^POST \/api\/cookbooks\/[^/]+\/share/, feature: 'cookbook', action: 'share' },
  { re: /^GET \/api\/cookbooks\/join\//, feature: 'cookbook', action: 'join' },
  { re: /^POST \/api\/cookbooks$/, feature: 'cookbook', action: 'create' },
  { re: /^GET \/api\/cookbooks/, feature: 'cookbook', action: 'view' },
  { re: /^(PUT|DELETE|POST) \/api\/cookbooks\//, feature: 'cookbook', action: 'edit' },

  // --- streaks
  { re: /^GET \/api\/streaks\/calendar/, feature: 'streaks', action: 'view_calendar' },
  { re: /^POST \/api\/streaks\/milestones/, feature: 'streaks', action: 'dismiss_milestone' },

  // --- integrations
  { re: /^GET \/api\/drive\/(status|sync-stats)/, feature: 'drive_sync', action: 'view' },
  { re: /^[A-Z]+ \/api\/drive/, feature: 'drive_sync', action: 'sync' },
  { re: /^[A-Z]+ \/api\/messenger/, feature: 'messenger', action: 'link' },
  { re: /^[A-Z]+ \/api\/instagram-dm/, feature: 'instagram_dm', action: 'link' },

  // --- account / settings
  { re: /^POST \/api\/auth\/signup/, feature: 'account', action: 'signup' },
  { re: /^POST \/api\/auth\/signin/, feature: 'account', action: 'signin' },
  { re: /^PATCH \/api\/auth\/profile/, feature: 'account', action: 'edit_profile' },
  { re: /^PATCH \/api\/auth\/(tour|welcome-tour)/, feature: 'guided_tour', action: 'update' },
  { re: /^POST \/api\/auth\/(delete-account|cancel-deletion)/, feature: 'account', action: 'deletion' },
  { re: /^[A-Z]+ \/api\/user-preferences/, feature: 'account', action: 'dietary_preferences' },
  { re: /^[A-Z]+ \/api\/onboarding/, feature: 'onboarding', action: 'progress' },
  { re: /^[A-Z]+ \/api\/push/, feature: 'notifications', action: 'settings' },
  { re: /^[A-Z]+ \/api\/subscriptions/, feature: 'subscription', action: 'manage' },
  { re: /^POST \/api\/support\/feedback/, feature: 'support', action: 'send_feedback' },
];

const METHOD_ACTION = { GET: 'view', POST: 'create', PUT: 'update', PATCH: 'update', DELETE: 'delete' };

/**
 * @param {string} method  HTTP method (upper-case)
 * @param {string} routePath  Express template path, e.g. '/api/inventory/:id'
 * @returns {{feature: string, action: string}|null}
 */
function resolveFeature(method, routePath) {
  if (!method || !routePath) return null;
  const key = `${method.toUpperCase()} ${routePath}`;
  if (SKIP.some((re) => re.test(key))) return null;
  const rule = RULES.find((r) => r.re.test(key));
  if (rule) return { feature: rule.feature, action: rule.action };
  // Generic fallback: feature = first path segment after /api, action = verb.
  const m = routePath.match(/^\/api\/([a-z-]+)/);
  if (!m) return null;
  return { feature: m[1].replace(/-/g, '_'), action: METHOD_ACTION[method.toUpperCase()] || 'other' };
}

/** Best-effort platform from headers. Mobile has no central API client, so
 *  fall back to the User-Agent (iOS URLSession = CFNetwork/Darwin). */
function resolvePlatform(req) {
  const explicit = (req.get('x-platform') || '').toLowerCase();
  if (explicit) return explicit;
  const ua = req.get('user-agent') || '';
  if (/Mozilla/i.test(ua)) return 'web';
  if (/CFNetwork|Darwin|iOS|iPhone|iPad/i.test(ua)) return 'ios';
  if (/okhttp|Android/i.test(ua)) return 'android';
  return 'unknown';
}

module.exports = { resolveFeature, resolvePlatform };
