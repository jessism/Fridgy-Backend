/**
 * Admin analytics — DB-native numbers for the trackabite.app/admin/analytics
 * page (signups, activity, subscriptions, per-user lookup, feature adoption).
 *
 * Behavioural analytics (DAU/MAU, retention, funnels, feature trends) live in
 * PostHog; this module only aggregates what already sits in Supabase.
 *
 * Read-only. Every query goes through getServiceClient(); the "real user"
 * filter below is applied everywhere so test accounts never leak into numbers.
 */
const { getServiceClient } = require('../config/supabase');
const revenueCatService = require('./revenueCatService');

const SYSTEM_USER_ID = '00000000-0000-0000-0000-000000000001'; // migrations/063
const DEFAULT_EXCLUDED_EMAILS = ['hello@trackabite.app', 'jessie@trackabite.app', 'adityabiswas1999@hotmail.com'];
const EXCLUDED_EMAILS = new Set(
  (process.env.ADMIN_ANALYTICS_EXCLUDED_EMAILS || DEFAULT_EXCLUDED_EMAILS.join(','))
    .split(',').map((e) => e.trim().toLowerCase()).filter(Boolean)
);

const USER_COLUMNS = 'id,email,first_name,created_at,tier,is_admin,is_grandfathered,signup_platform,last_active_at,deletion_status';
const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map(); // key -> { at, value }

async function cached(key, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;
  const value = await fn();
  cache.set(key, { at: Date.now(), value });
  return value;
}

/** True for accounts that must never count as real users. */
function isExcludedUser(u) {
  const email = (u.email || '').toLowerCase();
  return !email
    || u.id === SYSTEM_USER_ID
    || u.is_admin === true
    || email.includes('test')
    || EXCLUDED_EMAILS.has(email);
}

/** Page through a PostgREST query (default cap is 1000 rows). */
async function fetchAll(table, select, applyFilters) {
  const sb = getServiceClient();
  const rows = [];
  const page = 1000;
  for (let from = 0; ; from += page) {
    let q = sb.from(table).select(select).range(from, from + page - 1);
    if (applyFilters) q = applyFilters(q);
    const { data, error } = await q;
    if (error) throw new Error(`${table}: ${error.message}`);
    rows.push(...data);
    if (data.length < page) break;
  }
  return rows;
}

let userColumns = USER_COLUMNS;

async function loadRealUsers() {
  return cached('realUsers', async () => {
    let all;
    try {
      all = await fetchAll('users', userColumns);
    } catch (err) {
      // Migration 078 (last_active_at) not applied yet — degrade instead of failing.
      if (!/last_active_at/.test(err.message)) throw err;
      console.warn('[AdminAnalytics] users.last_active_at missing — apply migrations/078_add_last_active_at.sql');
      userColumns = USER_COLUMNS.replace(',last_active_at', '');
      all = await fetchAll('users', userColumns);
    }
    return all.filter((u) => !isExcludedUser(u));
  });
}

// Tables that count as "using a feature". user: column holding the user id.
const FEATURE_TABLES = [
  { feature: 'inventory',        table: 'fridge_items',          user: 'user_id',  time: 'updated_at', filter: (q) => q.is('deleted_at', null) },
  { feature: 'meal_log',         table: 'meal_logs',             user: 'user_id',  time: 'logged_at' },
  { feature: 'recipe_import',    table: 'import_jobs',           user: 'user_id',  time: 'created_at' },
  { feature: 'saved_recipes',    table: 'saved_recipes',         user: 'user_id',  time: 'created_at' },
  { feature: 'ai_recipes',       table: 'ai_generated_recipes',  user: 'user_id',  time: 'created_at' },
  { feature: 'shopping_list',    table: 'shopping_list_items',   user: 'added_by', time: 'added_at' },
  { feature: 'shopping_list_owner', table: 'shopping_lists',     user: 'owner_id', time: 'created_at' },
  { feature: 'meal_plan',        table: 'meal_plans',            user: 'user_id',  time: 'created_at' },
  { feature: 'cookbook',         table: 'cookbooks',             user: 'user_id',  time: 'created_at' },
  { feature: 'inventory_usage',  table: 'inventory_usage',       user: 'user_id',  time: 'used_at' },
  { feature: 'streaks',          table: 'streak_daily_log',      user: 'user_id',  time: 'date' },
  { feature: 'guided_tour',      table: 'user_tours',            user: 'user_id',  time: 'created_at' },
  { feature: 'push_notifications', table: 'mobile_push_tokens',  user: 'user_id',  time: 'created_at' },
];

const median = (a) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const p90 = (a) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.ceil(0.9 * s.length) - 1)]; };

/** Per-feature adoption across real users, plus per-user counts for the users table. */
async function loadFeatureUsage(realIds, sinceIso) {
  const perUserCounts = new Map(); // userId -> { feature: count }
  const features = [];
  for (const f of FEATURE_TABLES) {
    let rows = [];
    try {
      rows = await fetchAll(f.table, `${f.user},${f.time}`, f.filter);
    } catch (err) {
      features.push({ feature: f.feature, error: err.message });
      continue;
    }
    const per = {};
    const recent = new Set();
    for (const r of rows) {
      const uid = r[f.user];
      if (!realIds.has(uid)) continue;
      per[uid] = (per[uid] || 0) + 1;
      if (r[f.time] && String(r[f.time]) >= sinceIso) recent.add(uid);
      const bucket = perUserCounts.get(uid) || {};
      bucket[f.feature] = (bucket[f.feature] || 0) + 1;
      perUserCounts.set(uid, bucket);
    }
    const counts = Object.values(per);
    features.push({
      feature: f.feature,
      table: f.table,
      adopters: counts.length,
      activeInWindow: recent.size,
      rows: counts.reduce((a, b) => a + b, 0),
      medianPerAdopter: median(counts),
      p90PerAdopter: p90(counts),
    });
  }
  return { features, perUserCounts };
}

/** Latest RevenueCat event per email (app_user_id is the email in this app). */
async function loadLatestRcEventByEmail() {
  const events = await fetchAll('revenuecat_webhook_events', 'event_type,app_user_id,product_id,created_at', (q) => q.order('created_at', { ascending: false }));
  const latest = new Map();
  for (const e of events) {
    const key = (e.app_user_id || '').toLowerCase();
    if (key && !latest.has(key)) latest.set(key, e);
  }
  return { events, latest };
}

const RC_ACTIVE_TYPES = new Set(['INITIAL_PURCHASE', 'RENEWAL', 'UNCANCELLATION', 'PRODUCT_CHANGE', 'CANCELLATION', 'BILLING_ISSUE']); // CANCELLATION = auto-renew off, still entitled until EXPIRATION

function subscriptionState(user, stripeSub, latestRc) {
  if (latestRc && RC_ACTIVE_TYPES.has(latestRc.event_type)) {
    return { source: 'revenuecat', status: latestRc.event_type === 'CANCELLATION' ? 'canceling' : 'active', productId: latestRc.product_id };
  }
  if (stripeSub && ['active', 'trialing', 'past_due'].includes(stripeSub.status)) {
    return { source: 'stripe', status: stripeSub.status, productId: stripeSub.stripe_price_id };
  }
  if (user.tier === 'grandfathered' || user.is_grandfathered) return { source: 'grandfathered', status: 'grandfathered' };
  if (latestRc) return { source: 'revenuecat', status: latestRc.event_type.toLowerCase() };
  if (stripeSub) return { source: 'stripe', status: stripeSub.status };
  return { source: null, status: 'free' };
}

function dayKey(iso) { return String(iso).slice(0, 10); }

async function getOverview({ days = 30 } = {}) {
  const now = Date.now();
  const sinceIso = new Date(now - days * 864e5).toISOString();
  const users = await loadRealUsers();
  const realIds = new Set(users.map((u) => u.id));

  const [{ features, perUserCounts }, subs, rc] = await Promise.all([
    cached(`featureUsage:${days}`, () => loadFeatureUsage(realIds, sinceIso)),
    fetchAll('subscriptions', 'user_id,status,tier,stripe_price_id,trial_start,trial_end,canceled_at,created_at'),
    cached('rcEvents', loadLatestRcEventByEmail),
  ]);
  const subByUser = new Map(subs.map((s) => [s.user_id, s]));

  // Signups: daily series inside the window, by platform.
  const series = {};
  for (let d = days - 1; d >= 0; d--) series[dayKey(new Date(now - d * 864e5).toISOString())] = { date: dayKey(new Date(now - d * 864e5).toISOString()), mobile: 0, web: 0, other: 0 };
  const byPlatform = {};
  let signups7 = 0, signups30 = 0, signupsWindow = 0;
  for (const u of users) {
    const plat = u.signup_platform || 'other';
    byPlatform[plat] = (byPlatform[plat] || 0) + 1;
    const age = now - new Date(u.created_at).getTime();
    if (age < 7 * 864e5) signups7++;
    if (age < 30 * 864e5) signups30++;
    if (u.created_at >= sinceIso) {
      signupsWindow++;
      const k = dayKey(u.created_at);
      if (series[k]) series[k][plat in series[k] ? plat : 'other']++;
    }
  }

  // Activity from last_active_at (written by middleware/featureTracking.js).
  const active = (ms) => users.filter((u) => u.last_active_at && now - new Date(u.last_active_at).getTime() < ms).length;

  // Subscription state per user.
  const subscriptionCounts = {};
  const trialsInWindow = rc.events.filter((e) => e.event_type === 'INITIAL_PURCHASE' && e.created_at >= sinceIso && realIds.has(emailToId(users, e.app_user_id))).length;
  const churnInWindow = rc.events.filter((e) => e.event_type === 'EXPIRATION' && e.created_at >= sinceIso && realIds.has(emailToId(users, e.app_user_id))).length;
  for (const u of users) {
    const st = subscriptionState(u, subByUser.get(u.id), rc.latest.get((u.email || '').toLowerCase()));
    subscriptionCounts[st.status] = (subscriptionCounts[st.status] || 0) + 1;
  }

  const activated = users.filter((u) => {
    const c = perUserCounts.get(u.id);
    return c && Object.keys(c).some((f) => !['guided_tour', 'push_notifications'].includes(f));
  }).length;

  return {
    generatedAt: new Date(now).toISOString(),
    windowDays: days,
    excludedEmails: [...EXCLUDED_EMAILS],
    totals: {
      realUsers: users.length,
      activated,
      signups7d: signups7,
      signups30d: signups30,
      signupsInWindow: signupsWindow,
      active1d: active(864e5),
      active7d: active(7 * 864e5),
      active30d: active(30 * 864e5),
      lastActiveTracked: users.some((u) => u.last_active_at),
    },
    signupsByPlatform: byPlatform,
    signupSeries: Object.values(series),
    subscriptions: { counts: subscriptionCounts, newPurchasesInWindow: trialsInWindow, expirationsInWindow: churnInWindow },
    features: features
      .filter((f) => !f.error)
      .map((f) => ({ ...f, adoptionPct: users.length ? Math.round((100 * f.adopters) / users.length) : 0, activePct: users.length ? Math.round((100 * f.activeInWindow) / users.length) : 0 }))
      .sort((a, b) => b.adopters - a.adopters),
    featureErrors: features.filter((f) => f.error),
  };
}

function emailToId(users, email) {
  const e = (email || '').toLowerCase();
  const u = users.find((x) => (x.email || '').toLowerCase() === e);
  return u ? u.id : null;
}

async function listUsers({ search = '', sort = 'created_at', dir = 'desc', page = 1, pageSize = 50 } = {}) {
  const users = await loadRealUsers();
  const realIds = new Set(users.map((u) => u.id));
  const [{ perUserCounts }, subs, streaks, rc] = await Promise.all([
    cached('featureUsage:30', () => loadFeatureUsage(realIds, new Date(Date.now() - 30 * 864e5).toISOString())),
    fetchAll('subscriptions', 'user_id,status,tier,stripe_price_id'),
    fetchAll('user_streaks', 'user_id,current_streak,longest_streak,last_activity_date'),
    cached('rcEvents', loadLatestRcEventByEmail),
  ]);
  const subByUser = new Map(subs.map((s) => [s.user_id, s]));
  const streakByUser = new Map(streaks.map((s) => [s.user_id, s]));

  const q = search.trim().toLowerCase();
  let rows = users
    .filter((u) => !q || (u.email || '').toLowerCase().includes(q) || (u.first_name || '').toLowerCase().includes(q) || u.id === q)
    .map((u) => ({
      id: u.id,
      email: u.email,
      firstName: u.first_name,
      createdAt: u.created_at,
      signupPlatform: u.signup_platform,
      tier: u.tier,
      lastActiveAt: u.last_active_at,
      deletionStatus: u.deletion_status,
      subscription: subscriptionState(u, subByUser.get(u.id), rc.latest.get((u.email || '').toLowerCase())),
      streak: streakByUser.get(u.id) || null,
      features: perUserCounts.get(u.id) || {},
    }));

  const key = { created_at: 'createdAt', last_active_at: 'lastActiveAt', email: 'email' }[sort] || 'createdAt';
  rows.sort((a, b) => {
    const av = a[key] || '', bv = b[key] || '';
    return (av < bv ? -1 : av > bv ? 1 : 0) * (dir === 'asc' ? 1 : -1);
  });

  const total = rows.length;
  const start = (Math.max(1, page) - 1) * pageSize;
  return { total, page, pageSize, users: rows.slice(start, start + pageSize) };
}

async function getUserDetail(userId) {
  const sb = getServiceClient();
  await loadRealUsers(); // resolves userColumns
  const { data: user, error } = await sb.from('users').select(userColumns).eq('id', userId).single();
  if (error || !user) return null;
  const email = (user.email || '').toLowerCase();

  const [subRes, rcRes, streakRes, onboardingRes, usageRes, liveRc] = await Promise.all([
    sb.from('subscriptions').select('*').eq('user_id', userId).maybeSingle(),
    sb.from('revenuecat_webhook_events').select('event_type,product_id,created_at,processed,error_message').ilike('app_user_id', email).order('created_at', { ascending: false }).limit(50),
    sb.from('user_streaks').select('*').eq('user_id', userId).maybeSingle(),
    sb.from('user_onboarding_data').select('primary_goal,household_size,weekly_budget,onboarding_completed,created_at').eq('user_id', userId).maybeSingle(),
    sb.from('usage_limits').select('*').eq('user_id', userId).maybeSingle(),
    revenueCatService.getSubscriberInfo(user.email).catch(() => null),
  ]);

  const counts = {};
  for (const f of FEATURE_TABLES) {
    let q = sb.from(f.table).select('*', { count: 'exact', head: true }).eq(f.user, userId);
    if (f.filter) q = f.filter(q);
    const { count } = await q;
    counts[f.feature] = count || 0;
  }

  return {
    user: {
      id: user.id, email: user.email, firstName: user.first_name, createdAt: user.created_at,
      tier: user.tier, isGrandfathered: user.is_grandfathered, signupPlatform: user.signup_platform,
      lastActiveAt: user.last_active_at, deletionStatus: user.deletion_status, excluded: isExcludedUser(user),
    },
    subscription: subscriptionState(user, subRes.data, rcRes.data && rcRes.data[0]),
    stripeSubscription: subRes.data || null,
    revenueCatEvents: rcRes.data || [],
    revenueCatLive: liveRc ? { entitlements: liveRc.entitlements, subscriptions: liveRc.subscriptions, firstSeen: liveRc.first_seen, lastSeen: liveRc.last_seen } : null,
    streak: streakRes.data || null,
    onboarding: onboardingRes.data || null,
    usageLimits: usageRes.data || null,
    featureCounts: counts,
  };
}

module.exports = { getOverview, listUsers, getUserDetail, isExcludedUser, loadRealUsers, EXCLUDED_EMAILS };
