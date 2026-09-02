const { getServiceClient } = require('../config/supabase');
const {
  costForCategory,
  CONSUMED_REASONS,
  WASTED_REASON,
  clampDays,
} = require('../services/insightsConstants');

// Response contract for GET /api/inventory-analytics/usage
// ---------------------------------------------------------
// Two live clients read this payload: the mobile app (features/inventory-usage)
// and the web app (Frontend/src/pages/InventoryUsagePage.js). The web page
// replaces its state wholesale with `data` and then dereferences
// `previousPeriod.*` and calls `valueSaved.toFixed(2)` unguarded, with no
// error boundary. So on every 200:
//   - previousPeriod is always present with itemsConsumed/itemsWasted/
//     valueSaved/usagePercentage
//   - every numeric field is a JS number (never null / string)
//   - usagePercentage and categoryBreakdown values are rounded integers
// New fields may be ADDED; existing ones must keep their type.
//
// Metric definitions (product-level, like CozZo / Kitche):
//   itemsConsumed  = COUNT fridge_items rows soft-deleted as used_up|auto_depleted
//   itemsWasted    = COUNT fridge_items rows soft-deleted as thrown_away
//   usagePercentage= consumed / (consumed + wasted)
//   ingredientUses = COUNT inventory_usage rows (one per ingredient per logged meal)
// The previous implementation summed quantities across incompatible units
// (grams + pieces + litres) and mixed partial deductions into "items".

const DEBUG = process.env.INSIGHTS_DEBUG === 'true';
const debug = (...args) => { if (DEBUG) console.log(...args); };

const { fetchAllRows, fetchUsageRows } = require('../services/insightsService');

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const pct = (num, den) => (den > 0 ? Math.round((num / den) * 100) : 0);
const getUserIdFromToken = (req) => {
  if (!req.user || !req.user.id) throw new Error('No authenticated user');
  return req.user.id;
};

const usageItemName = (row) => row.item_name || row.fridge_items?.item_name || null;
const usageCategory = (row) => row.category || row.fridge_items?.category || 'Other';

// Mean gap in days between consecutive dates; 0 when there is only one.
function averageGapDays(dates) {
  if (dates.length < 2) return 0;
  const sorted = [...dates].sort((a, b) => a - b);
  let total = 0;
  for (let i = 1; i < sorted.length; i++) total += (sorted[i] - sorted[i - 1]) / 86400000;
  return Math.round(total / (sorted.length - 1));
}

// Top-N by event count from a list of {name, date} events.
function topItems(events, limit = 5) {
  const stats = new Map();
  for (const { name, date } of events) {
    if (!name) continue;
    const entry = stats.get(name) || { count: 0, dates: [] };
    entry.count += 1;
    entry.dates.push(date);
    stats.set(name, entry);
  }
  return [...stats.entries()]
    .map(([itemName, s]) => ({ itemName, count: s.count, avgDays: averageGapDays(s.dates) }))
    .sort((a, b) => b.count - a.count || a.itemName.localeCompare(b.itemName))
    .slice(0, limit);
}

// Summarise one window of deleted fridge_items rows.
function summariseDeletions(rows) {
  const consumed = rows.filter((r) => CONSUMED_REASONS.includes(r.delete_reason));
  const wasted = rows.filter((r) => r.delete_reason === WASTED_REASON);
  const value = (list) => round2(list.reduce((sum, r) => sum + costForCategory(r.category), 0));

  const categoryCounts = {};
  for (const r of consumed) {
    const c = r.category || 'Other';
    categoryCounts[c] = (categoryCounts[c] || 0) + 1;
  }
  const categoryBreakdown = {};
  for (const [c, n] of Object.entries(categoryCounts)) categoryBreakdown[c] = pct(n, consumed.length);

  return {
    itemsConsumed: consumed.length,
    itemsWasted: wasted.length,
    valueSaved: value(consumed),
    valueWasted: value(wasted),
    usagePercentage: pct(consumed.length, consumed.length + wasted.length),
    categoryBreakdown,
    // Manual "used it up" is one use of that item. Auto-depleted rows already
    // have a matching inventory_usage row, so they are excluded here.
    manualUseEvents: consumed
      .filter((r) => r.delete_reason === 'used_up')
      .map((r) => ({ name: r.item_name, date: new Date(r.deleted_at) })),
    wasteEvents: wasted.map((r) => ({ name: r.item_name, date: new Date(r.deleted_at) })),
  };
}

const inventoryAnalyticsController = {
  // Dev-only diagnostics (route is premium-gated; mobile button is __DEV__-only).
  async debugAnalytics(req, res) {
    const requestId = Math.random().toString(36).substring(7);
    try {
      const userId = getUserIdFromToken(req);
      const supabase = getServiceClient();
      const days = clampDays(req.query.days);
      const now = new Date();
      const startDate = new Date(now.getTime() - days * 86400000);

      const [items, deleted, usage] = await Promise.all([
        supabase.from('fridge_items').select('id, item_name, quantity, category, delete_reason, deleted_at, created_at')
          .eq('user_id', userId).order('created_at', { ascending: false }).limit(10),
        supabase.from('fridge_items').select('id, item_name, quantity, category, delete_reason, deleted_at')
          .eq('user_id', userId).not('deleted_at', 'is', null).order('deleted_at', { ascending: false }).limit(10),
        supabase.from('inventory_usage').select('id, amount_used, unit, usage_type, used_at, notes')
          .eq('user_id', userId).order('used_at', { ascending: false }).limit(10),
      ]);

      const recentDeletions = (deleted.data || []).filter((i) => new Date(i.deleted_at) >= startDate);

      res.json({
        success: true,
        debug: {
          userId,
          authentication: 'successful',
          totalFridgeItems: items.data?.length || 0,
          deletedItemsCount: deleted.data?.length || 0,
          inventoryUsageRecords: usage.data?.length || 0,
          dateRange: { days, startDate: startDate.toISOString(), endDate: now.toISOString() },
          recentDeletionsInRange: recentDeletions.length,
          sampleData: {
            recentItems: (items.data || []).slice(0, 2),
            recentDeletions: (deleted.data || []).slice(0, 2),
            recentUsage: (usage.data || []).slice(0, 2),
          },
          errors: [items.error, deleted.error, usage.error].filter(Boolean).map((e) => e.message),
        },
        requestId,
      });
    } catch (error) {
      console.error(`💥 [${requestId}] Analytics debug error:`, error);
      res.status(error.message.includes('authenticated') ? 401 : 500).json({
        success: false,
        error: 'Debug failed',
        details: error.message,
        requestId,
      });
    }
  },

  // GET /api/inventory-analytics/usage?days=7|30|90
  async getUsageAnalytics(req, res) {
    const requestId = Math.random().toString(36).substring(7);
    const startedAt = Date.now();

    try {
      const days = clampDays(req.query.days);
      const userId = getUserIdFromToken(req);
      const supabase = getServiceClient();

      // Rolling windows in UTC (unchanged behaviour): [previousStart, start) and [start, now).
      const now = new Date();
      const startDate = new Date(now.getTime() - days * 86400000);
      const previousStartDate = new Date(startDate.getTime() - days * 86400000);
      const nowIso = now.toISOString();
      const startIso = startDate.toISOString();
      const prevIso = previousStartDate.toISOString();

      // Two paginated queries cover both periods; split in memory.
      const [deletedRows, usageRows] = await Promise.all([
        fetchAllRows(() => supabase
          .from('fridge_items')
          .select('id, item_name, category, delete_reason, deleted_at')
          .eq('user_id', userId)
          .in('delete_reason', [...CONSUMED_REASONS, WASTED_REASON])
          .gte('deleted_at', prevIso)
          .lt('deleted_at', nowIso)
          .order('id', { ascending: true })),
        fetchUsageRows(supabase, userId, prevIso, nowIso),
      ]);

      const inCurrent = (iso) => iso >= startIso;
      const current = summariseDeletions(deletedRows.filter((r) => inCurrent(r.deleted_at)));
      const previous = summariseDeletions(deletedRows.filter((r) => !inCurrent(r.deleted_at)));
      const currentUsage = usageRows.filter((r) => inCurrent(r.used_at));
      const previousUsage = usageRows.filter((r) => !inCurrent(r.used_at));

      const useEvents = currentUsage
        .map((r) => ({ name: usageItemName(r), date: new Date(r.used_at) }))
        .concat(current.manualUseEvents);

      const analyticsData = {
        // --- original contract (types unchanged: all numbers / rounded ints)
        itemsConsumed: current.itemsConsumed,
        itemsWasted: current.itemsWasted,
        valueSaved: current.valueSaved,
        usagePercentage: current.usagePercentage,
        previousPeriod: {
          itemsConsumed: previous.itemsConsumed,
          itemsWasted: previous.itemsWasted,
          valueSaved: previous.valueSaved,
          usagePercentage: previous.usagePercentage,
          // additive
          valueWasted: previous.valueWasted,
          ingredientUses: previousUsage.length,
        },
        categoryBreakdown: current.categoryBreakdown,
        mostUsedItems: topItems(useEvents),
        period: { days, startDate: startIso, endDate: nowIso },
        // --- additive fields (Phase 2 groundwork; ignored by current clients)
        valueWasted: current.valueWasted,
        ingredientUses: currentUsage.length,
        mostWastedItems: topItems(current.wasteEvents),
      };

      debug(`📊 [${requestId}] analytics user=${userId} days=${days} rows=${deletedRows.length}+${usageRows.length} in ${Date.now() - startedAt}ms`, {
        consumed: analyticsData.itemsConsumed,
        wasted: analyticsData.itemsWasted,
        uses: analyticsData.ingredientUses,
        usage: `${analyticsData.usagePercentage}%`,
      });

      res.json({ success: true, data: analyticsData, requestId });
    } catch (error) {
      console.error(`💥 [${requestId}] Inventory analytics error:`, error);
      const authError = error.message.includes('authenticated') || error.message.includes('token');
      res.status(authError ? 401 : 500).json({
        success: false,
        error: authError ? 'Authentication required' : 'Failed to fetch analytics',
        requestId,
      });
    }
  },
};

module.exports = inventoryAnalyticsController;
