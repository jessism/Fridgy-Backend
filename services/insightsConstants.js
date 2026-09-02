/**
 * Shared constants for user-facing inventory insights.
 *
 * Kept in one place so the analytics controller, the cook-events endpoint and
 * the (future) /api/insights endpoint all agree on what a "consumed" item is
 * and what each category is worth.
 */

// Per-item USD estimates. Keys are the EXACT category strings the mobile app
// writes (see trackabite-mobile/features/inventory/types/index.ts) — the old
// table used lowercase singular keys ('vegetable') that never matched
// ('Vegetables'), so 6 of 9 categories silently priced at the $1.50 fallback.
const FOOD_COST_ESTIMATES = {
  'Protein': 4.50,
  'Dairy': 2.00,
  'Vegetables': 1.25,
  'Fruits': 1.75,
  'Grains': 0.85,
  'Fats and oils': 2.25,
  'Beverages': 2.50,
  'Seasonings': 0.75,
  'Other': 1.50,
};

const costForCategory = (category) =>
  FOOD_COST_ESTIMATES[category] ?? FOOD_COST_ESTIMATES['Other'];

// fridge_items.delete_reason values that mean "the food was eaten".
//  - used_up:       user tapped "Used it up" (manual soft delete)
//  - auto_depleted: a logged meal / cooked recipe deducted the last of it
//                   (inventoryDeductionService — soft-deletes since migration 083)
// A partial deduction is NOT a consumed item; it is an "ingredient use"
// (one inventory_usage row per ingredient per meal).
const CONSUMED_REASONS = ['used_up', 'auto_depleted'];
const WASTED_REASON = 'thrown_away';

// Optional "why?" answered when an item is thrown away. Mirrors the CHECK
// constraint added in migration 083. NULL = user skipped.
const WASTE_REASONS = ['expired', 'spoiled_early', 'cooked_too_much', 'didnt_like', 'other'];

// Where a cooked recipe came from (cook_events.recipe_source CHECK).
const COOK_SOURCES = ['saved', 'ai', 'popular', 'community', 'unsaved'];

// Allowed analytics windows. Anything else is coerced to the default.
const ALLOWED_DAYS = [7, 30, 90];
const DEFAULT_DAYS = 30;
const clampDays = (value) => {
  const n = parseInt(value, 10);
  return ALLOWED_DAYS.includes(n) ? n : DEFAULT_DAYS;
};

module.exports = {
  FOOD_COST_ESTIMATES,
  costForCategory,
  CONSUMED_REASONS,
  WASTED_REASON,
  WASTE_REASONS,
  COOK_SOURCES,
  ALLOWED_DAYS,
  DEFAULT_DAYS,
  clampDays,
};
