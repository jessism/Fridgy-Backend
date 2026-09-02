/**
 * Shape/logic test for services/insightsService.js with a stubbed Supabase
 * client — no network, no env. Run: node scripts/test-insights-shape.js
 *
 * Checks the things the mobile client and the web page depend on:
 *  - every section present, numbers are numbers, deltas suppressed for free
 *  - product-level counting (auto_depleted counts once, partial uses don't)
 *  - tolerant of cook_events / snapshot columns not existing yet (pre-083)
 */
const assert = require('assert');

// ---- stub PostgREST client -------------------------------------------------
const NOW = new Date('2026-09-01T18:00:00Z');
const daysAgo = (n, h = 12) => new Date(NOW.getTime() - n * 86400000 - (12 - h) * 3600000).toISOString();

const TABLES = {
  users: [{ id: 'u1', timezone: 'America/Vancouver' }],
  fridge_items: [
    // current window (7d): 3 consumed (1 manual, 2 auto), 2 wasted
    { id: 1, user_id: 'u1', item_name: 'Spinach', category: 'Vegetables', quantity: 1, unit: 'bag', expiration_date: '2026-08-30', delete_reason: 'thrown_away', waste_reason: 'expired', deleted_at: daysAgo(1), weight_equivalent: null, weight_unit: 'oz' },
    { id: 2, user_id: 'u1', item_name: 'Milk', category: 'Dairy', quantity: 2, unit: 'L', expiration_date: '2026-09-05', delete_reason: 'auto_depleted', waste_reason: null, deleted_at: daysAgo(2), weight_equivalent: null, weight_unit: 'oz' },
    { id: 3, user_id: 'u1', item_name: 'Chicken', category: 'Protein', quantity: 1, unit: 'lb', expiration_date: '2026-09-02', delete_reason: 'auto_depleted', waste_reason: null, deleted_at: daysAgo(3), weight_equivalent: 16, weight_unit: 'oz' },
    { id: 4, user_id: 'u1', item_name: 'Yogurt', category: 'Dairy', quantity: 1, unit: 'pieces', expiration_date: null, delete_reason: 'used_up', waste_reason: null, deleted_at: daysAgo(4), weight_equivalent: null, weight_unit: 'oz' },
    { id: 5, user_id: 'u1', item_name: 'Spinach', category: 'Vegetables', quantity: 1, unit: 'bag', expiration_date: '2026-08-25', delete_reason: 'thrown_away', waste_reason: null, deleted_at: daysAgo(5), weight_equivalent: null, weight_unit: 'oz' },
    // previous window
    { id: 6, user_id: 'u1', item_name: 'Bread', category: 'Grains', quantity: 1, unit: 'loaf', expiration_date: null, delete_reason: 'thrown_away', waste_reason: 'cooked_too_much', deleted_at: daysAgo(9), weight_equivalent: null, weight_unit: 'oz' },
    { id: 7, user_id: 'u1', item_name: 'Eggs', category: 'Protein', quantity: 12, unit: 'pieces', expiration_date: null, delete_reason: 'used_up', waste_reason: null, deleted_at: daysAgo(10), weight_equivalent: null, weight_unit: 'oz' },
    // 'mistake' must be ignored entirely
    { id: 8, user_id: 'u1', item_name: 'Ghost', category: 'Other', quantity: 1, unit: 'pieces', expiration_date: null, delete_reason: 'mistake', waste_reason: null, deleted_at: daysAgo(1), weight_equivalent: null, weight_unit: 'oz' },
  ],
  // milk used in 3 meals then depleted → 3 ingredient uses, but only 1 consumed item
  inventory_usage: [
    { id: 'a', user_id: 'u1', usage_type: 'meal', amount_used: 0.5, unit: 'L', used_at: daysAgo(6), item_id: 2, item_name: 'Milk', category: 'Dairy' },
    { id: 'b', user_id: 'u1', usage_type: 'meal', amount_used: 0.5, unit: 'L', used_at: daysAgo(4), item_id: 2, item_name: 'Milk', category: 'Dairy' },
    { id: 'c', user_id: 'u1', usage_type: 'meal', amount_used: 1.0, unit: 'L', used_at: daysAgo(2), item_id: 2, item_name: 'Milk', category: 'Dairy' },
    { id: 'd', user_id: 'u1', usage_type: 'meal', amount_used: 1, unit: 'lb', used_at: daysAgo(3), item_id: 3, item_name: 'Chicken', category: 'Protein' },
    { id: 'e', user_id: 'u1', usage_type: 'meal', amount_used: 2, unit: 'pieces', used_at: daysAgo(10), item_id: 7, item_name: 'Eggs', category: 'Protein' },
  ],
  meal_logs: [
    { id: 'm1', user_id: 'u1', meal_type: 'dinner', is_dine_out: false, logged_at: daysAgo(2), ingredients_logged: [{ name: 'milk', calories: 150 }, { name: 'chicken', calories: 400 }] },
    { id: 'm2', user_id: 'u1', meal_type: 'lunch', is_dine_out: true, logged_at: daysAgo(3), ingredients_logged: [{ name: 'burger', calories: 700 }] },
    { id: 'm3', user_id: 'u1', meal_type: 'dinner', is_dine_out: false, logged_at: daysAgo(6), ingredients_logged: [] },
  ],
  cook_events: [
    { id: 'c1', user_id: 'u1', recipe_id: null, recipe_name: 'Pasta', recipe_name_key: 'pasta', cuisines: ['Italian'], items_rescued_count: 2, cooked_at: daysAgo(2) },
    { id: 'c2', user_id: 'u1', recipe_id: null, recipe_name: 'Pasta', recipe_name_key: 'pasta', cuisines: ['Italian'], items_rescued_count: 0, cooked_at: daysAgo(5) },
    { id: 'c3', user_id: 'u1', recipe_id: null, recipe_name: 'Tacos', recipe_name_key: 'tacos', cuisines: ['Mexican'], items_rescued_count: 1, cooked_at: daysAgo(1) },
    { id: 'c0', user_id: 'u1', recipe_id: null, recipe_name: 'Pasta', recipe_name_key: 'pasta', cuisines: ['Italian'], items_rescued_count: 0, cooked_at: daysAgo(20) },
  ],
  user_streaks: [{ user_id: 'u1', current_streak: 4, longest_streak: 9 }],
  saved_recipes: [
    // cooked ONLY via cook_events title match (times_cooked 0); NULL import_method must be kept
    { id: 'r1', user_id: 'u1', title: '  Pasta ', cuisines: ['Italian'], source_type: 'instagram', times_cooked: 0, created_at: daysAgo(20), import_method: null },
    // cooked via the counter; saved in the CURRENT window
    { id: 'r2', user_id: 'u1', title: 'Salad', cuisines: ['Mediterranean'], source_type: 'web', times_cooked: 2, created_at: daysAgo(3), import_method: 'web' },
    // never cooked; saved in the PREVIOUS window
    { id: 'r3', user_id: 'u1', title: 'Smoothie', cuisines: [], source_type: 'ai', times_cooked: 0, created_at: daysAgo(10), import_method: 'ai' },
    // the seeded default recipe — must be excluded everywhere
    { id: 'r4', user_id: 'u1', title: 'Rosemary Gnocchi', cuisines: ['Italian'], source_type: 'manual', times_cooked: 0, created_at: daysAgo(40), import_method: 'default_seed' },
  ],
  streak_daily_log: [
    { id: 's1', user_id: 'u1', date: '2026-08-31', status: 'active' },
    { id: 's2', user_id: 'u1', date: '2026-08-30', status: 'active' },
    { id: 's3', user_id: 'u1', date: '2026-08-29', status: 'missed' },
  ],
};

let missingTables = new Set();
// table → Set(columns) that a not-yet-applied migration would add
let missingColumns = {};

function makeQuery(table) {
  const filters = [];
  let selectCols = '*';
  const q = {
    select(cols) { selectCols = cols; return q; },
    eq(c, v) { filters.push((r) => r[c] === v); return q; },
    in(c, vs) { filters.push((r) => vs.includes(r[c])); return q; },
    gte(c, v) { filters.push((r) => r[c] >= v); return q; },
    lt(c, v) { filters.push((r) => r[c] < v); return q; },
    lte(c, v) { filters.push((r) => r[c] <= v); return q; },
    is(c, v) { filters.push((r) => (v === null ? r[c] == null : r[c] === v)); return q; },
    not() { return q; },
    // minimal .or(): comma-separated "col.op.value" terms, ORed. Handles the
    // is.null / neq patterns the service uses.
    or(expr) {
      const terms = expr.split(',').map((t) => {
        const [col, op, ...rest] = t.split('.');
        const val = rest.join('.');
        if (op === 'is' && val === 'null') return (r) => r[col] == null;
        if (op === 'neq') return (r) => r[col] != null && r[col] !== val;
        if (op === 'eq') return (r) => r[col] === val;
        throw new Error(`stub .or(): unsupported term ${t}`);
      });
      filters.push((r) => terms.some((f) => f(r)));
      return q;
    },
    order() { return q; },
    limit() { return q; },
    maybeSingle() { return q.range(0, 0).then((res) => ({ data: res.data?.[0] ?? null, error: res.error })); },
    range(from, to) {
      if (missingTables.has(table)) return Promise.resolve({ data: null, error: { code: '42P01', message: `relation "${table}" does not exist` } });
      // Only TOP-LEVEL selected columns count; an embed like fridge_items:item_id(item_name)
      // refers to the other table and is valid regardless.
      const topLevel = selectCols.replace(/\w+:\w+\([^)]*\)/g, '');
      for (const col of missingColumns[table] || []) {
        if (new RegExp(`(^|[,\\s])${col}([,\\s]|$)`).test(topLevel)) {
          return Promise.resolve({ data: null, error: { code: '42703', message: `column ${table}.${col} does not exist` } });
        }
      }
      // Project like PostgREST: only selected top-level columns come back, and
      // an embed fridge_items:item_id(cols) resolves against the FK target.
      const embed = selectCols.match(/(\w+):(\w+)\(([^)]*)\)/);
      const cols = selectCols === '*' ? null : topLevel.split(',').map((c) => c.trim()).filter(Boolean);
      const project = (r) => {
        const out = cols ? Object.fromEntries(cols.map((c) => [c, r[c]])) : { ...r };
        if (embed) {
          const [, alias, fk, inner] = embed;
          const target = (TABLES[alias] || []).find((t) => t.id === r[fk]);
          out[alias] = target ? Object.fromEntries(inner.split(',').map((c) => c.trim()).map((c) => [c, target[c]])) : null;
        }
        return out;
      };
      const rows = (TABLES[table] || []).filter((r) => filters.every((f) => f(r))).slice(from, to + 1).map(project);
      return Promise.resolve({ data: rows, error: null });
    },
    then(res, rej) { return q.range(0, 999).then(res, rej); },
  };
  return q;
}
const fakeClient = { from: (t) => makeQuery(t) };

// Patch before the service loads (it destructures getServiceClient at require time).
const cfg = require('../config/supabase');
cfg.getServiceClient = () => fakeClient;
const insightsService = require('../services/insightsService');

// Freeze "now" for moment
const moment = require('moment-timezone');
moment.now = () => NOW.getTime();

(async () => {
  // ---- premium, 7d, everything present -------------------------------------
  const p = await insightsService.getInsights('u1', 7, { tier: 'premium', isPremium: true });
  const sections = ['period', 'tier', 'locked', 'hero', 'trend', 'waste', 'cooking', 'meals', 'habits', 'impact', 'methodology'];
  for (const s of sections) assert.ok(p[s] !== undefined, `missing section ${s}`);

  // product-level counting: Milk (auto), Chicken (auto), Yogurt (used_up) = 3; Spinach ×2 wasted; 'mistake' ignored
  assert.strictEqual(p.hero.itemsConsumed.current, 3, 'consumed = 3 (auto_depleted counts once each)');
  assert.strictEqual(p.hero.itemsWasted.current, 2);
  assert.strictEqual(p.hero.usedPct, 60);
  assert.strictEqual(p.hero.ingredientUses.current, 4, 'ingredient uses = 4 (3 milk + 1 chicken), separate from items');
  assert.strictEqual(p.hero.itemsConsumed.available, true, 'premium sees deltas when previous > 0');
  assert.strictEqual(p.hero.itemsConsumed.previous, 1);
  assert.strictEqual(p.trend.granularity, 'day');
  assert.strictEqual(p.trend.points.length, 7);
  assert.strictEqual(p.trend.points.reduce((s, x) => s + x.consumed, 0), 3, 'trend buckets sum to consumed');
  assert.strictEqual(p.trend.points.reduce((s, x) => s + x.wasted, 0), 2);

  // waste
  assert.strictEqual(p.waste.mostWasted[0].itemName, 'Spinach');
  assert.strictEqual(p.waste.mostWasted[0].count, 2);
  assert.strictEqual(p.waste.byCategory[0].category, 'Vegetables');
  assert.strictEqual(p.waste.byCategory[0].pct, 100);
  assert.deepStrictEqual(p.waste.reasonsCoverage, { answered: 1, total: 2 });
  assert.strictEqual(p.waste.dominantTip.reason, 'expired');
  assert.strictEqual(p.waste.expiredInFridge, 2, 'both spinach rows deleted after their expiry date');
  assert.strictEqual(typeof p.waste.valueSaved.current, 'number');
  assert.ok(Math.abs(p.waste.valueSaved.current - (2.00 + 4.50 + 2.00)) < 1e-9, 'Dairy 2 + Protein 4.5 + Dairy 2 with FIXED category keys');
  assert.ok(Math.abs(p.waste.valueWasted.current - 2.50) < 1e-9, 'Vegetables 1.25 × 2');
  assert.ok(p.waste.benchmark.userAnnualizedWaste > 0);

  // cooking: 3 cooks this week; Pasta most cooked (2); Tacos is new (first ever cook in window); Pasta is not (cooked 20d ago)
  assert.strictEqual(p.cooking.cooks.current, 3);
  assert.strictEqual(p.cooking.mostCooked[0].recipeName, 'Pasta');
  assert.strictEqual(p.cooking.mostCooked[0].count, 2);
  assert.strictEqual(p.cooking.newRecipesTried.current, 1, 'only Tacos is new');
  assert.strictEqual(p.cooking.itemsRescued, 3);
  assert.strictEqual(p.cooking.topIngredients[0].name, 'Milk');
  assert.strictEqual(p.cooking.topIngredients[0].count, 3);
  assert.strictEqual(p.cooking.cuisines[0].cuisine, 'Italian');

  // meals
  assert.strictEqual(p.meals.logged.current, 3);
  assert.strictEqual(p.meals.eatIn, 2);
  assert.strictEqual(p.meals.dineOut, 1);
  assert.strictEqual(p.meals.eatInPct, 67);
  assert.strictEqual(p.meals.calories.avgPerDay, Math.round((550 + 700) / 2), 'days with 0 kcal excluded from the average');
  assert.strictEqual(p.meals.calories.daysLogged, 3);

  // habits
  assert.strictEqual(p.habits.currentStreak, 4);
  assert.strictEqual(p.habits.longestStreak, 9);
  assert.strictEqual(p.habits.activeDays, 2);
  assert.strictEqual(p.habits.zeroWasteWeeks.weeks.length, 1);
  assert.strictEqual(p.habits.zeroWasteWeeks.current, 0, 'something was wasted this week');

  // impact: kg > 0, meals rescued derived, numbers
  assert.ok(p.impact.kgRescued > 0);
  assert.strictEqual(typeof p.impact.co2eKg, 'number');
  assert.ok(p.methodology.costPerItem.Vegetables === 1.25);

  // recipes: seed excluded, NULL import_method kept, cooked via key OR counter
  assert.strictEqual(p.recipes.libraryTotal, 3, 'default_seed excluded, NULL import_method kept');
  assert.strictEqual(p.recipes.cookedCount, 2, 'Pasta via cook_events key (trimmed/lowered), Salad via times_cooked');
  assert.strictEqual(p.recipes.neverCookedCount, 1);
  assert.strictEqual(p.recipes.cookedPct, 67);
  assert.strictEqual(p.recipes.savedThisPeriod.current, 1, 'Salad saved in current 7d');
  assert.strictEqual(p.recipes.savedThisPeriod.previous, 1, 'Smoothie saved in previous 7d');
  assert.strictEqual(p.recipes.topCuisines[0].cuisine, 'Italian', 'tie broken alphabetically');
  assert.strictEqual(p.recipes.sources.length, 3);

  // ---- free, 7d: deltas + trend locked, ranges 30/90 locked -----------------
  const f = await insightsService.getInsights('u1', 7, { tier: 'free', isPremium: false });
  assert.strictEqual(f.trend, null);
  assert.deepStrictEqual(f.locked, { deltas: true, trend: true, ranges: [30, 90] });
  assert.strictEqual(f.hero.itemsConsumed.available, false);
  assert.strictEqual(f.hero.itemsConsumed.previous, null, 'never ship a number the client must hide');
  assert.strictEqual(f.hero.itemsConsumed.current, 3);
  assert.strictEqual(f.recipes.savedThisPeriod.available, false, 'recipes delta locked for free');

  // ---- 30d premium: week buckets --------------------------------------------
  insightsService.invalidateInsights('u1');
  const m = await insightsService.getInsights('u1', 30, { tier: 'premium', isPremium: true });
  assert.strictEqual(m.trend.granularity, 'week');
  assert.strictEqual(m.trend.points.length, 5);
  assert.strictEqual(m.hero.itemsConsumed.current, 4, '30d includes previous-week Eggs');

  // ---- cache: second call served from cache ---------------------------------
  const again = await insightsService.getInsights('u1', 30, { tier: 'premium', isPremium: true });
  assert.strictEqual(again.cached, true);

  // ---- pre-migration DB: cook_events missing + snapshot columns missing -----
  insightsService.invalidateInsights('u1');
  missingTables = new Set(['cook_events']);
  missingColumns = { fridge_items: ['waste_reason'], inventory_usage: ['item_name', 'category'] };
  const pre = await insightsService.getInsights('u1', 7, { tier: 'premium', isPremium: true });
  assert.strictEqual(pre.cooking.cooks.current, 0, 'no cook_events table → empty cooking, no crash');
  assert.strictEqual(pre.hero.itemsConsumed.current, 3, 'fridge_items query falls back without waste_reason');
  assert.strictEqual(pre.hero.ingredientUses.current, 4, 'inventory_usage falls back to FK embed shape');
  assert.deepStrictEqual(pre.waste.reasons, []);
  assert.strictEqual(pre.recipes.cookedCount, 1, 'without cook_events only times_cooked counts (Salad)');
  assert.strictEqual(pre.recipes.libraryTotal, 3);

  // ---- legacy GET /api/inventory-analytics/usage — the web page's contract ----
  // Frontend/src/pages/InventoryUsagePage.js dereferences previousPeriod.* and
  // calls valueSaved.toFixed(2) unguarded with no error boundary.
  missingTables = new Set();
  missingColumns = {};
  const legacy = require('../controller/inventoryAnalyticsController');
  const captured = {};
  const res = { status(c) { captured.status = c; return res; }, json(b) { captured.body = b; return res; }, set() { return res; } };
  await legacy.getUsageAnalytics({ user: { id: 'u1' }, query: { days: '100000' } }, res);
  const d = captured.body.data;
  assert.strictEqual(captured.body.success, true);
  assert.strictEqual(d.period.days, 30, 'days=100000 clamps to the default');
  for (const k of ['itemsConsumed', 'itemsWasted', 'valueSaved', 'usagePercentage']) {
    assert.strictEqual(typeof d[k], 'number', `${k} is a number`);
    assert.strictEqual(typeof d.previousPeriod[k], 'number', `previousPeriod.${k} is a number`);
  }
  assert.ok(Number.isInteger(d.usagePercentage), 'usagePercentage is a rounded integer');
  assert.ok(Number.isInteger(d.itemsConsumed) && Number.isInteger(d.itemsWasted), 'items are counts, not quantity sums');
  assert.ok(Object.values(d.categoryBreakdown).every(Number.isInteger));
  assert.ok(Array.isArray(d.mostUsedItems) && d.mostUsedItems.every((i) => 'itemName' in i && 'count' in i && 'avgDays' in i));
  // The same 30-day window as the new endpoint: 4 consumed items
  assert.strictEqual(d.itemsConsumed, 4);
  assert.strictEqual(d.itemsWasted, 3);

  console.log('✅ insightsService + legacy analytics contract: all assertions passed');
  process.exit(0);
})().catch((e) => {
  console.error('❌ FAILED:', e.message);
  console.error(e.stack);
  process.exit(1);
});
