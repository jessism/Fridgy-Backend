/**
 * insightsService — everything behind GET /api/insights.
 *
 * One payload, six sections (hero, waste, cooking, meals, habits, impact) plus
 * a methodology block so the client never hardcodes a price or a factor.
 *
 * Data facts this depends on (see MD_files/PLAN_ANALYTICSUPGRADE_AUG30.md):
 *  - "items consumed" = fridge_items soft-deleted as used_up | auto_depleted
 *    (product-level). inventory_usage is one row per ingredient per logged
 *    meal — an "ingredient use", NOT a consumed item.
 *  - On mobile, Cooking Mode deducts nothing; only meal logging does. Cooking
 *    stats come from cook_events (mobile ✓ button), never from inventory.
 *  - fridge_items.quantity keeps its pre-deduction value on auto_depleted rows
 *    (CHECK quantity > 0), so it is never trusted as "how much was eaten".
 */
const moment = require('moment-timezone');
const NodeCache = require('node-cache');
const { getServiceClient } = require('../config/supabase');
const {
  FOOD_COST_ESTIMATES,
  costForCategory,
  CONSUMED_REASONS,
  WASTED_REASON,
  ALLOWED_DAYS,
} = require('./insightsConstants');

const DEBUG = process.env.INSIGHTS_DEBUG === 'true';
const debug = (...a) => { if (DEBUG) console.log('[Insights]', ...a); };

// ── cache ────────────────────────────────────────────────────────────────────
// Per-process, like usageService's limitCache. Short TTL: the three writers
// that change these numbers (item delete, meal log, cook complete) also
// invalidate explicitly; dine-out logs / meal deletes rely on the TTL.
const cache = new NodeCache({ stdTTL: 120, checkperiod: 60, useClones: false });
const cacheKey = (userId, days, isPremium) => `insights:${userId}:${days}:${isPremium ? 'p' : 'f'}`;
function invalidateInsights(userId) {
  for (const d of ALLOWED_DAYS) {
    cache.del(cacheKey(userId, d, true));
    cache.del(cacheKey(userId, d, false));
  }
}

// ── constants exposed via methodology ────────────────────────────────────────
// Typical retail weight of ONE item per category, used only when the row has
// no weight_equivalent. Rough by design; shown to the user as an estimate.
const WEIGHT_PER_ITEM_KG = {
  'Protein': 0.45,
  'Dairy': 0.50,
  'Vegetables': 0.30,
  'Fruits': 0.25,
  'Grains': 0.50,
  'Fats and oils': 0.40,
  'Beverages': 1.00,
  'Seasonings': 0.10,
  'Other': 0.30,
};
const OZ_TO_KG = 0.0283495;
const FACTORS = {
  mealsPerKg: 1 / 0.42,      // WRAP: 420 g ≈ one meal
  co2ePerKgFood: 3.67,       // WRAP life-cycle factor (as published by Olio)
  waterLitresPerKgFood: 337, // Kitche, derived from WRAP water-footprint work
};
const BENCHMARK = {
  perPersonPerYear: 728,        // EPA (Apr 2025), 2023 prices
  householdOfFourPerYear: 2913, // EPA (Apr 2025)
  source: 'US EPA, "Estimating the Cost of Food Waste to American Consumers" (2025)',
};
const SOURCES = [
  { label: 'EPA — cost of food waste to US consumers (2025)', url: 'https://www.epa.gov/system/files/documents/2025-04/costoffoodwastereport_508.pdf' },
  { label: 'WRAP — household food & drink waste in the UK (2022)', url: 'https://www.wrap.ngo/resources/report/household-food-and-drink-waste-uk-2022' },
  { label: 'Olio — how impact is calculated (CO₂e, meals)', url: 'https://help.olioapp.com/en/articles/12149395-how-is-my-impact-calculated-on-olio' },
  { label: 'Kitche — impact methodology (water)', url: 'https://kitche.co/impact/' },
];

const WASTE_TIPS = {
  expired: 'Most of what you tossed simply ran out of time. Check the "Expiring soon" filter before you shop, and cook from it first.',
  spoiled_early: 'Food is going off before its date. Keep the fridge at or below 4 °C and store produce in the crisper drawer.',
  cooked_too_much: 'Leftovers are your biggest source of waste. Try scaling recipes down a serving, or plan a leftovers night.',
  didnt_like: 'You are buying things you don\'t end up enjoying. Try a smaller quantity first, or save recipes you know you like.',
  other: 'Tag the reason next time you throw something out — after a few, this space turns into a specific suggestion.',
};
const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// ── helpers ──────────────────────────────────────────────────────────────────
const PAGE_SIZE = 1000;
const MAX_PAGES = 20;
async function fetchAllRows(makeQuery) {
  const rows = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const from = page * PAGE_SIZE;
    const { data, error } = await makeQuery().range(from, from + PAGE_SIZE - 1);
    if (error) throw error;
    rows.push(...(data || []));
    if (!data || data.length < PAGE_SIZE) break;
  }
  return rows;
}

// Tolerates a table or column that a hand-applied migration hasn't created yet.
const MISSING_SCHEMA = new Set(['42703', '42P01', 'PGRST200', 'PGRST204']);
async function tolerant(fn, fallback) {
  try {
    return await fn();
  } catch (error) {
    if (MISSING_SCHEMA.has(error?.code)) {
      debug('schema not ready, falling back:', error.code, error.message);
      return fallback;
    }
    throw error;
  }
}

// inventory_usage with item snapshots (migration 083) or the FK embed.
async function fetchUsageRows(supabase, userId, startIso, endIso) {
  const base = (select) => () => supabase
    .from('inventory_usage')
    .select(select)
    .eq('user_id', userId)
    .eq('usage_type', 'meal')
    .gte('used_at', startIso)
    .lt('used_at', endIso)
    .order('id', { ascending: true });
  try {
    return await fetchAllRows(base('id, amount_used, unit, used_at, item_id, item_name, category, fridge_items:item_id(item_name, category)'));
  } catch (error) {
    if (error?.code !== '42703') throw error;
    return await fetchAllRows(base('id, amount_used, unit, used_at, item_id, fridge_items:item_id(item_name, category)'));
  }
}
const usageItemName = (r) => r.item_name || r.fridge_items?.item_name || null;

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const round1 = (n) => Math.round((Number(n) || 0) * 10) / 10;
const pct = (num, den) => (den > 0 ? Math.round((num / den) * 100) : 0);
const median = (arr) => {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round(((s[mid - 1] + s[mid]) / 2) * 10) / 10;
};

function delta(current, previous, { available = true } = {}) {
  const ok = available && previous > 0;
  return {
    current,
    previous: ok ? previous : null,
    changePct: ok ? Math.round(((current - previous) / previous) * 100) : null,
    available: ok,
  };
}

function countBy(rows, keyFn) {
  const map = new Map();
  for (const r of rows) {
    const k = keyFn(r);
    if (k == null || k === '') continue;
    map.set(k, (map.get(k) || 0) + 1);
  }
  return map;
}
const sortedCounts = (map) => [...map.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])));

function estimateKg(row) {
  const w = parseFloat(row.weight_equivalent);
  if (Number.isFinite(w) && w > 0 && (row.weight_unit || 'oz') === 'oz') return w * OZ_TO_KG;
  const qty = parseFloat(row.quantity);
  // Live fridge_items has NO unit column (verified 2026-09-01) — row.unit is
  // always undefined there, so this branch only fires if one is ever added.
  const unit = String(row.unit || '').toLowerCase();
  if (Number.isFinite(qty) && qty > 0) {
    if (unit === 'kg' || unit === 'l' || unit === 'liter' || unit === 'litre') return qty;
    if (unit === 'g' || unit === 'ml') return qty / 1000;
    if (unit === 'lb' || unit === 'lbs') return qty * 0.4536;
    if (unit === 'oz') return qty * OZ_TO_KG;
  }
  return WEIGHT_PER_ITEM_KG[row.category] ?? WEIGHT_PER_ITEM_KG['Other'];
}

const dayKey = (iso, tz) => moment.utc(iso).tz(tz).format('YYYY-MM-DD');
const weekdayOf = (iso, tz) => moment.utc(iso).tz(tz).day();

// ── main ─────────────────────────────────────────────────────────────────────
/**
 * @param {string} userId
 * @param {7|30|90} days
 * @param {{ tier: string, isPremium: boolean }} sub
 */
async function getInsights(userId, days, sub) {
  const key = cacheKey(userId, days, sub.isPremium);
  const hit = cache.get(key);
  if (hit) return { ...hit, cached: true };

  const supabase = getServiceClient();
  const startedAt = Date.now();

  // Timezone first: every day bucket depends on it (mealController pattern).
  const { data: userRow } = await supabase.from('users').select('timezone').eq('id', userId).maybeSingle();
  const tz = userRow?.timezone || 'America/Los_Angeles';

  const end = moment.tz(tz).endOf('day');
  const start = moment.tz(tz).subtract(days - 1, 'days').startOf('day');
  const prevStart = start.clone().subtract(days, 'days');
  const nowIso = end.clone().utc().toISOString();
  const startIso = start.clone().utc().toISOString();
  const prevIso = prevStart.clone().utc().toISOString();
  const startLocal = start.format('YYYY-MM-DD');
  const inCurrent = (iso) => iso >= startIso;

  const [deletedRows, usageRows, mealRows, cookRows, earlierCookKeys, streakRow, dailyLog] = await Promise.all([
    fetchAllRows(() => supabase
      .from('fridge_items')
      .select('id, item_name, category, quantity, weight_equivalent, weight_unit, expiration_date, delete_reason, waste_reason, deleted_at')
      .eq('user_id', userId)
      .in('delete_reason', [...CONSUMED_REASONS, WASTED_REASON])
      .gte('deleted_at', prevIso)
      .lt('deleted_at', nowIso)
      .order('id', { ascending: true }))
      // waste_reason arrives with migration 083
      .catch((e) => (e?.code === '42703'
        ? fetchAllRows(() => supabase
          .from('fridge_items')
          .select('id, item_name, category, quantity, weight_equivalent, weight_unit, expiration_date, delete_reason, deleted_at')
          .eq('user_id', userId)
          .in('delete_reason', [...CONSUMED_REASONS, WASTED_REASON])
          .gte('deleted_at', prevIso)
          .lt('deleted_at', nowIso)
          .order('id', { ascending: true }))
        : Promise.reject(e))),
    fetchUsageRows(supabase, userId, prevIso, nowIso),
    fetchAllRows(() => supabase
      .from('meal_logs')
      .select('id, meal_type, is_dine_out, ingredients_logged, logged_at')
      .eq('user_id', userId)
      .gte('logged_at', prevIso)
      .lt('logged_at', nowIso)
      .order('id', { ascending: true })),
    tolerant(() => fetchAllRows(() => supabase
      .from('cook_events')
      .select('id, recipe_id, recipe_name, recipe_name_key, cuisines, items_rescued_count, cooked_at')
      .eq('user_id', userId)
      .gte('cooked_at', prevIso)
      .lt('cooked_at', nowIso)
      .order('id', { ascending: true })), []),
    tolerant(() => fetchAllRows(() => supabase
      .from('cook_events')
      .select('id, recipe_name_key, cooked_at')
      .eq('user_id', userId)
      .lt('cooked_at', prevIso)
      .order('id', { ascending: true })), []),
    tolerant(async () => {
      const { data, error } = await supabase.from('user_streaks').select('current_streak, longest_streak').eq('user_id', userId).maybeSingle();
      if (error) throw error;
      return data;
    }, null),
    tolerant(() => fetchAllRows(() => supabase
      .from('streak_daily_log')
      .select('id, date, status')
      .eq('user_id', userId)
      .gte('date', startLocal)
      .order('id', { ascending: true })), []),
  ]);

  // ── split windows ──────────────────────────────────────────────────────────
  const delCur = deletedRows.filter((r) => inCurrent(r.deleted_at));
  const delPrev = deletedRows.filter((r) => !inCurrent(r.deleted_at));
  const consumed = (rows) => rows.filter((r) => CONSUMED_REASONS.includes(r.delete_reason));
  const wasted = (rows) => rows.filter((r) => r.delete_reason === WASTED_REASON);
  const cCur = consumed(delCur), wCur = wasted(delCur), cPrev = consumed(delPrev), wPrev = wasted(delPrev);
  const useCur = usageRows.filter((r) => inCurrent(r.used_at));
  const usePrev = usageRows.filter((r) => !inCurrent(r.used_at));
  const mealCur = mealRows.filter((r) => inCurrent(r.logged_at));
  const mealPrev = mealRows.filter((r) => !inCurrent(r.logged_at));
  const cookCur = cookRows.filter((r) => inCurrent(r.cooked_at));
  const cookPrev = cookRows.filter((r) => !inCurrent(r.cooked_at));

  const value = (rows) => round2(rows.reduce((s, r) => s + costForCategory(r.category), 0));
  const deltas = sub.isPremium;
  const D = (cur, prev) => delta(cur, prev, { available: deltas });

  // ── hero ───────────────────────────────────────────────────────────────────
  const tracked = cCur.length + wCur.length;
  const trackedPrev = cPrev.length + wPrev.length;
  const usedPct = tracked > 0 ? pct(cCur.length, tracked) : null;
  const usedPctPrev = trackedPrev > 0 ? pct(cPrev.length, trackedPrev) : 0;
  const headline = tracked === 0
    ? 'Nothing tracked yet'
    : usedPct >= 90 ? 'Almost nothing wasted'
      : usedPct >= 75 ? 'Most of your food got eaten'
        : usedPct >= 50 ? 'Room to rescue more'
          : 'More went to the bin than the plate';

  const hero = {
    usedPct,
    usedPctDelta: D(usedPct ?? 0, usedPctPrev),
    itemsTracked: tracked,
    itemsConsumed: D(cCur.length, cPrev.length),
    itemsWasted: D(wCur.length, wPrev.length),
    ingredientUses: D(useCur.length, usePrev.length),
    headline,
    caption: tracked === 0
      ? 'Log a meal or mark an item used to start'
      : `based on ${tracked} item${tracked === 1 ? '' : 's'} tracked`,
    hasData: tracked > 0 || useCur.length > 0,
  };

  // ── trend (premium) ────────────────────────────────────────────────────────
  let trend = null;
  if (sub.isPremium) {
    const granularity = days === 7 ? 'day' : 'week';
    const bucketCount = granularity === 'day' ? days : Math.ceil(days / 7);
    const points = Array.from({ length: bucketCount }, (_, i) => {
      const bStart = start.clone().add(granularity === 'day' ? i : i * 7, 'days');
      return {
        date: bStart.format('YYYY-MM-DD'),
        label: granularity === 'day' ? bStart.format('dd') : bStart.format('M/D'),
        consumed: 0,
        wasted: 0,
      };
    });
    const bucketOf = (iso) => {
      const d = moment.utc(iso).tz(tz).startOf('day').diff(start, 'days');
      const idx = granularity === 'day' ? d : Math.floor(d / 7);
      return idx >= 0 && idx < points.length ? idx : null;
    };
    for (const r of cCur) { const b = bucketOf(r.deleted_at); if (b != null) points[b].consumed += 1; }
    for (const r of wCur) { const b = bucketOf(r.deleted_at); if (b != null) points[b].wasted += 1; }
    trend = { granularity, points };
  }

  // ── waste ──────────────────────────────────────────────────────────────────
  const byCategoryMap = countBy(wCur, (r) => r.category || 'Other');
  const reasonsMap = countBy(wCur, (r) => r.waste_reason || null);
  const answered = [...reasonsMap.values()].reduce((a, b) => a + b, 0);
  const dominant = sortedCounts(reasonsMap)[0]?.[0] || null;
  const todayLocal = moment.tz(tz).format('YYYY-MM-DD');
  const expiredInFridge = wCur.filter((r) => r.expiration_date && dayKey(r.deleted_at, tz) > r.expiration_date).length;
  const daysToSpare = cCur
    .filter((r) => r.expiration_date)
    .map((r) => moment(r.expiration_date, 'YYYY-MM-DD').diff(moment(dayKey(r.deleted_at, tz), 'YYYY-MM-DD'), 'days'))
    .filter((d) => d >= 0);
  const valueWastedCur = value(wCur);

  const waste = {
    currency: 'USD',
    valueSaved: D(value(cCur), value(cPrev)),
    valueWasted: D(valueWastedCur, value(wPrev)),
    mostWasted: sortedCounts(countBy(wCur, (r) => r.item_name)).slice(0, 5).map(([itemName, count]) => ({
      itemName,
      count,
      category: wCur.find((r) => r.item_name === itemName)?.category || 'Other',
    })),
    byCategory: sortedCounts(byCategoryMap).map(([category, count]) => ({ category, count, pct: pct(count, wCur.length) })),
    reasons: sortedCounts(reasonsMap).map(([reason, count]) => ({ reason, count, pct: pct(count, answered) })),
    reasonsCoverage: { answered, total: wCur.length },
    dominantTip: dominant ? { reason: dominant, text: WASTE_TIPS[dominant] || WASTE_TIPS.other } : null,
    expiredInFridge,
    usedWithDaysToSpare: { count: daysToSpare.length, medianDays: median(daysToSpare) },
    benchmark: {
      ...BENCHMARK,
      currency: 'USD',
      userAnnualizedWaste: round2(valueWastedCur * (365 / days)),
    },
    hasData: tracked > 0,
  };

  // ── cooking ────────────────────────────────────────────────────────────────
  const firstCookByKey = new Map();
  for (const r of [...earlierCookKeys, ...cookRows]) {
    const prev = firstCookByKey.get(r.recipe_name_key);
    if (!prev || r.cooked_at < prev) firstCookByKey.set(r.recipe_name_key, r.cooked_at);
  }
  const newKeysIn = (rows) => new Set(rows.map((r) => r.recipe_name_key).filter((k) => {
    const first = firstCookByKey.get(k);
    return first && rows.some((r) => r.recipe_name_key === k && r.cooked_at === first);
  })).size;
  const cuisineMap = new Map();
  for (const r of cookCur) for (const c of (r.cuisines || [])) cuisineMap.set(c, (cuisineMap.get(c) || 0) + 1);
  const cuisineTotal = [...cuisineMap.values()].reduce((a, b) => a + b, 0);

  const cooking = {
    cooks: D(cookCur.length, cookPrev.length),
    mostCooked: sortedCounts(countBy(cookCur, (r) => r.recipe_name_key)).slice(0, 3).map(([k, count]) => {
      const sample = cookCur.find((r) => r.recipe_name_key === k);
      return { recipeId: sample?.recipe_id || null, recipeName: sample?.recipe_name || k, count };
    }),
    newRecipesTried: D(newKeysIn(cookCur), newKeysIn(cookPrev)),
    topIngredients: sortedCounts(countBy(useCur, usageItemName)).slice(0, 5).map(([name, count]) => ({ name, count })),
    cuisines: sortedCounts(cuisineMap).slice(0, 5).map(([cuisine, count]) => ({ cuisine, count, pct: pct(count, cuisineTotal) })),
    itemsRescued: cookCur.reduce((s, r) => s + (r.items_rescued_count || 0), 0),
    hasData: cookCur.length > 0 || useCur.length > 0,
  };

  // ── meals ──────────────────────────────────────────────────────────────────
  const calsOf = (m) => {
    const list = Array.isArray(m.ingredients_logged) ? m.ingredients_logged
      : (m.ingredients_logged && Array.isArray(m.ingredients_logged.ingredients) ? m.ingredients_logged.ingredients : []);
    return list.reduce((s, i) => s + (Number(i?.calories) || 0), 0);
  };
  const calsByDay = new Map();
  for (const m of mealCur) {
    const k = dayKey(m.logged_at, tz);
    calsByDay.set(k, (calsByDay.get(k) || 0) + calsOf(m));
  }
  const daysLogged = calsByDay.size;
  const calDays = [...calsByDay.values()].filter((v) => v > 0);
  const avgPerDay = calDays.length ? Math.round(calDays.reduce((a, b) => a + b, 0) / calDays.length) : null;
  const eatIn = mealCur.filter((m) => !m.is_dine_out).length;
  const dineOut = mealCur.length - eatIn;
  const typeMap = countBy(mealCur, (m) => m.meal_type || 'other');
  const weekdayMap = countBy(mealCur, (m) => weekdayOf(m.logged_at, tz));
  const busiest = sortedCounts(weekdayMap)[0];

  const meals = {
    logged: D(mealCur.length, mealPrev.length),
    eatIn,
    dineOut,
    eatInPct: mealCur.length ? pct(eatIn, mealCur.length) : null,
    byType: sortedCounts(typeMap).map(([mealType, count]) => ({ mealType, count, pct: pct(count, mealCur.length) })),
    calories: {
      avgPerDay,
      daysLogged,
      daysInPeriod: days,
      caption: avgPerDay == null
        ? 'No calorie data yet — log a meal photo to start'
        : `based on ${calDays.length} of ${days} days logged`,
    },
    busiestWeekday: busiest ? { weekday: Number(busiest[0]), label: WEEKDAY_LABELS[Number(busiest[0])], count: busiest[1] } : null,
    hasData: mealCur.length > 0,
  };

  // ── habits ─────────────────────────────────────────────────────────────────
  const activeDays = dailyLog.filter((d) => d.status === 'active' || d.status === 'restored').length;
  const weekCount = Math.ceil(days / 7);
  const weeks = Array.from({ length: weekCount }, (_, i) => ({
    weekStart: start.clone().add(i * 7, 'days').format('YYYY-MM-DD'),
    wastedCount: 0,
  }));
  for (const r of wCur) {
    const idx = Math.floor(moment.utc(r.deleted_at).tz(tz).startOf('day').diff(start, 'days') / 7);
    if (idx >= 0 && idx < weeks.length) weeks[idx].wastedCount += 1;
  }
  let current = 0;
  for (let i = weeks.length - 1; i >= 0 && weeks[i].wastedCount === 0; i--) current += 1;
  let best = 0, run = 0;
  for (const w of weeks) { run = w.wastedCount === 0 ? run + 1 : 0; best = Math.max(best, run); }
  const habits = {
    currentStreak: streakRow?.current_streak || 0,
    longestStreak: streakRow?.longest_streak || 0,
    activeDays,
    daysInPeriod: days,
    // Only meaningful once something has been tracked; an empty account is not "zero waste".
    zeroWasteWeeks: tracked > 0 ? { current, best, weeks } : { current: 0, best: 0, weeks },
    hasData: activeDays > 0 || (streakRow?.longest_streak || 0) > 0,
  };

  // ── impact ─────────────────────────────────────────────────────────────────
  const kgRescued = round1(cCur.reduce((s, r) => s + estimateKg(r), 0));
  const kgWasted = round1(wCur.reduce((s, r) => s + estimateKg(r), 0));
  const impact = {
    kgRescued,
    kgWasted,
    mealsRescued: Math.round(kgRescued * FACTORS.mealsPerKg),
    co2eKg: round1(kgRescued * FACTORS.co2ePerKgFood),
    waterLitres: Math.round(kgRescued * FACTORS.waterLitresPerKgFood),
    hasData: cCur.length > 0,
  };

  const payload = {
    period: {
      days,
      startDate: startIso,
      endDate: nowIso,
      previousStartDate: prevIso,
      timezone: tz,
    },
    tier: sub.tier,
    locked: {
      deltas: !sub.isPremium,
      trend: !sub.isPremium,
      ranges: sub.isPremium ? [] : ALLOWED_DAYS.filter((d) => d !== 7),
    },
    hero,
    trend,
    waste,
    cooking,
    meals,
    habits,
    impact,
    methodology: {
      currency: 'USD',
      costPerItem: FOOD_COST_ESTIMATES,
      weightPerItemKg: WEIGHT_PER_ITEM_KG,
      factors: FACTORS,
      benchmark: BENCHMARK,
      sources: SOURCES,
    },
  };

  cache.set(key, payload);
  debug(`user=${userId} days=${days} tz=${tz} rows: del=${deletedRows.length} use=${usageRows.length} meals=${mealRows.length} cooks=${cookRows.length} in ${Date.now() - startedAt}ms`);
  return payload;
}

module.exports = {
  getInsights,
  invalidateInsights,
  // shared with inventoryAnalyticsController
  fetchAllRows,
  fetchUsageRows,
};
