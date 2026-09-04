/**
 * Admin analytics — DB-native numbers for the trackabite.app/admin console
 * (signups, activity, subscriptions, feature adoption, streaks, per-user lookup).
 *
 * Behavioural analytics (DAU/MAU, retention, funnels, feature trends) live in
 * PostHog; this module only aggregates what already sits in Supabase.
 *
 * Read-only. Every query goes through getServiceClient(); the "real user"
 * filter below is applied everywhere so test accounts never leak into numbers.
 *
 * Definitions that matter (see MD_files/PLAN_ANALYTICS_AUG29.md):
 * - Days are calendar days in ADMIN_TZ. A window of N days is the last N
 *   calendar days inclusive of today; tiles and charts share those buckets.
 * - Subscription status reports what the app ENFORCES (users.tier) and
 *   separately surfaces where the live evidence (Stripe row / RevenueCat
 *   production events) disagrees with it, instead of silently re-deriving.
 * - RevenueCat SANDBOX events never count toward anything.
 * - "Active" blends users.last_active_at (written by featureTracking since
 *   2026-08-29) with each user's latest feature write, so history before the
 *   middleware existed still shows up.
 */
const { getServiceClient } = require('../config/supabase');
const revenueCatService = require('./revenueCatService');
const { SYSTEM_USER_ID, INTERNAL_EMAILS, INTERNAL_DOMAINS, exclusionReason, isInternalAccount } = require('./internalAccounts');

const ADMIN_TZ = process.env.ADMIN_ANALYTICS_TZ || 'America/Vancouver';
const LAST_ACTIVE_TRACKED_SINCE = '2026-08-29'; // migration 078 + featureTracking deploy
const STREAKS_LAUNCHED = '2026-07-18';

const USER_COLUMNS = 'id,email,first_name,created_at,tier,is_admin,is_grandfathered,signup_platform,last_active_at,deletion_status';
const USER_COLUMNS_WITH_IS_TEST = `${USER_COLUMNS},is_test`;
const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map(); // key -> { at, value }

async function cached(key, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;
  const value = await fn();
  cache.set(key, { at: Date.now(), value });
  return value;
}

/** Kept as a named export for callers that predate services/internalAccounts.js. */
const isExcludedUser = isInternalAccount;

/**
 * Page through a PostgREST query (default cap is 1000 rows). Always ordered:
 * .range() without an ORDER BY is not stable in Postgres, so rows could be
 * duplicated or skipped between pages once a table passes 1000 rows.
 */
async function fetchAll(table, select, applyFilters, orderCol = 'id') {
  const sb = getServiceClient();
  const rows = [];
  const page = 1000;
  for (let from = 0; ; from += page) {
    let q = sb.from(table).select(select).order(orderCol, { ascending: true }).range(from, from + page - 1);
    if (applyFilters) q = applyFilters(q);
    const { data, error } = await q;
    if (error) throw new Error(`${table}: ${error.message}`);
    rows.push(...data);
    if (data.length < page) break;
  }
  return rows;
}

async function loadRealUsers() {
  return cached('realUsers', async () => {
    // Prefer users.is_test (migrations/080) so accounts can be flagged without
    // a deploy. If the column isn't applied yet, fall back for this call only —
    // no sticky flag, so it starts working the moment the migration lands.
    let all;
    try {
      all = await fetchAll('users', USER_COLUMNS_WITH_IS_TEST);
    } catch (err) {
      if (!/is_test/.test(err.message)) throw err;
      all = await fetchAll('users', USER_COLUMNS);
    }
    return all.filter((u) => !isExcludedUser(u));
  });
}

// ---------------------------------------------------------------------------
// Calendar helpers — everything is bucketed by local day in ADMIN_TZ.
// ---------------------------------------------------------------------------

/** 'YYYY-MM-DD' of an instant in ADMIN_TZ. Accepts ms or anything Date can parse. */
function dayKey(v) {
  const d = v instanceof Date ? v : new Date(v);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString('en-CA', { timeZone: ADMIN_TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
}

/** Shift a 'YYYY-MM-DD' key by n calendar days (pure calendar arithmetic, DST-proof). */
function shiftDay(key, n) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** The last `days` calendar keys ending today, oldest first. */
function windowKeys(days, nowMs) {
  const today = dayKey(nowMs);
  const keys = [];
  for (let i = days - 1; i >= 0; i--) keys.push(shiftDay(today, -i));
  return keys;
}

const toMs = (v) => (v ? Date.parse(v) : NaN);

// ---------------------------------------------------------------------------
// Feature adoption — only things a user chose to do.
// `streak_daily_log` is deliberately NOT here: it is written as a side effect
// of six other actions, so as "adoption" it means "did anything". It feeds the
// Streaks card instead (loadStreaks).
// ---------------------------------------------------------------------------
// Rows on saved_recipes with import_method = 'default_seed' are the "Rosemary
// Gnocchi" recipe that older accounts were given on signup (now disabled in
// authController). It is stored as an Instagram import, so without this filter
// 7 of 22 real users count as "saved a recipe" having never saved anything.
const notSeed = (q) => q.or('import_method.is.null,import_method.neq.default_seed');

/**
 * Where a saved recipe came from. Raw values are saved_recipes.source_type.
 *
 * Deliberately NOT import_method: that names the extraction pipeline
 * ('multi-modal-async', 'ai-web-extract'), which lumps Instagram, Facebook and
 * TikTok into one bucket and answers a question nobody asks. source_type holds
 * the platform, which is what "where do people get recipes from" means.
 */
const SOURCE_TYPE_LABELS = {
  instagram: 'Instagram',
  facebook: 'Facebook',
  tiktok: 'TikTok',
  youtube: 'YouTube',
  web: 'Web',
  scanned: 'Scan',
  manual: 'Manual entry',
  voice: 'Voice',
  ai_generated: 'AI generated',
  popular: 'Community pool',
  curated: 'Community pool',
};

/**
 * Always shown, in this order, even at zero — "nobody has ever typed one in by
 * hand" is a real answer, the same reason the table keeps 0% feature rows.
 * Anything else appears only when it has data, so the list stays bounded.
 */
const CANONICAL_SOURCES = ['instagram', 'facebook', 'tiktok', 'youtube', 'web', 'scanned', 'manual'];

const FEATURE_TABLES = [
  { feature: 'inventory',          group: 'feature', table: 'fridge_items',         user: 'user_id',  time: 'created_at',
    definition: 'Users with at least one fridge_items row (including items since deleted). Active = an item created in the window.' },
  { feature: 'meal_log',           group: 'feature', table: 'meal_logs',            user: 'user_id',  time: 'logged_at',
    definition: 'Users with at least one meal_logs row. Active = a meal logged in the window.' },
  // Recipe import used to be a second row counted from import_jobs. It was the
  // *same people* as this one — every real user with a saved recipe got it by
  // importing, and nobody imported without ending up with a recipe — so two
  // rows made one behaviour look like two. It is now the breakdown below.
  { feature: 'saved_recipes',      group: 'feature', table: 'saved_recipes',        user: 'user_id',  time: 'created_at', filter: notSeed,
    breakdown: { column: 'source_type', labels: SOURCE_TYPE_LABELS, canonical: CANONICAL_SOURCES, fallback: 'Other' },
    definition: 'Users with at least one saved_recipes row however it got there — import, iOS shortcut, scan, manual entry, community adopt — EXCLUDING the seeded "Rosemary Gnocchi" default recipe (import_method = default_seed) that older accounts received on signup. The breakdown shows which source each recipe came from; a person can use more than one, so those user counts can sum to more than the row total.' },
  { feature: 'ai_recipes',         group: 'feature', table: 'ai_generated_recipes', user: 'user_id',  time: 'created_at',
    definition: 'Users with at least one ai_generated_recipes row (generated a recipe from their inventory).' },
  { feature: 'shopping_list',      group: 'feature', table: 'shopping_list_items',  user: 'added_by', time: 'added_at',
    definition: 'Users who added at least one shopping_list_items row (added_by), including on lists shared with them.' },
  { feature: 'meal_plan',          group: 'feature', table: 'meal_plans',           user: 'user_id',  time: 'created_at',
    definition: 'Users with at least one meal_plans row.' },
  { feature: 'cookbook',           group: 'feature', table: 'cookbooks',            user: 'user_id',  time: 'created_at',
    definition: 'Users with at least one cookbooks row.' },
  { feature: 'inventory_usage',    group: 'feature', table: 'inventory_usage',      user: 'user_id',  time: 'used_at',
    definition: 'Users with at least one inventory_usage row (marked an inventory item as used or consumed).' },
  { feature: 'guided_tour',        group: 'setup',   table: 'user_tours',           user: 'user_id',  time: 'created_at',
    definition: 'Users with a user_tours row, created when the guided tour starts. Setup, not a feature: excluded from "Activated".' },
  { feature: 'push_notifications', group: 'setup',   table: 'mobile_push_tokens',   user: 'user_id',  time: 'created_at',
    definition: 'Users with a mobile_push_tokens row, registered when the app obtains a push token. Setup, not a feature: excluded from "Activated".' },
];
const SETUP_FEATURES = FEATURE_TABLES.filter((f) => f.group === 'setup').map((f) => f.feature);

const median = (a) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const p90 = (a) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.ceil(0.9 * s.length) - 1)]; };
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const round1 = (n) => Math.round(n * 10) / 10;

/**
 * Per-feature adoption across real users, per-user counts for the users
 * table, and each user's latest feature write (feeds the "active" blend).
 */

/**
 * Canonical buckets first, in configured order and including zeros, then any
 * other value that actually occurred (sorted by users). `pct` uses the same
 * denominator as the parent row so the two columns are comparable.
 */
function buildBreakdown(cfg, tally, realTotal) {
  const pct = (n) => (realTotal ? Math.round((100 * n) / realTotal) : 0);
  const seen = new Set();
  const row = (raw) => {
    const b = tally.get(raw) || { users: new Set(), rows: 0 };
    seen.add(raw);
    return {
      key: raw,
      label: raw === '__none__' ? cfg.fallback : (cfg.labels[raw] || raw),
      users: b.users.size,
      rows: b.rows,
      pct: pct(b.users.size),
    };
  };

  const canonical = (cfg.canonical || []).map(row);
  const extras = [...tally.keys()]
    .filter((raw) => !seen.has(raw))
    .map(row)
    .filter((r) => r.users > 0 || r.rows > 0)
    .sort((a, b) => b.users - a.users || b.rows - a.rows);

  // Labels can collide (popular and curated are both "Community pool"): merge
  // them so the same name never appears twice.
  const merged = [];
  for (const r of [...canonical, ...extras]) {
    const hit = merged.find((m) => m.label === r.label);
    if (hit) { hit.users += r.users; hit.rows += r.rows; hit.pct = pct(hit.users); }
    else merged.push(r);
  }
  return merged;
}

async function loadFeatureUsage(realIds, windowStartKey) {
  const realTotal = realIds.size;
  const perUserCounts = new Map(); // userId -> { feature: count }
  const perUserLastMs = new Map(); // userId -> ms of latest feature write
  const features = [];
  for (const f of FEATURE_TABLES) {
    let rows = [];
    try {
      const cols = f.breakdown ? `${f.user},${f.time},${f.breakdown.column}` : `${f.user},${f.time}`;
      rows = await fetchAll(f.table, cols, f.filter);
    } catch (err) {
      features.push({ feature: f.feature, group: f.group, definition: f.definition, error: err.message });
      continue;
    }
    const per = {};
    const recent = new Set();
    const byMethod = new Map(); // raw value -> { users:Set, rows:number }
    for (const r of rows) {
      const uid = r[f.user];
      if (!realIds.has(uid)) continue;
      per[uid] = (per[uid] || 0) + 1;
      if (f.breakdown) {
        const raw = r[f.breakdown.column] || '__none__';
        if (!byMethod.has(raw)) byMethod.set(raw, { users: new Set(), rows: 0 });
        const b = byMethod.get(raw);
        b.users.add(uid);
        b.rows += 1;
      }
      const ms = toMs(r[f.time]);
      if (!Number.isNaN(ms)) {
        if (dayKey(ms) >= windowStartKey) recent.add(uid);
        if (!perUserLastMs.has(uid) || ms > perUserLastMs.get(uid)) perUserLastMs.set(uid, ms);
      }
      const bucket = perUserCounts.get(uid) || {};
      bucket[f.feature] = (bucket[f.feature] || 0) + 1;
      perUserCounts.set(uid, bucket);
    }
    const counts = Object.values(per);
    features.push({
      feature: f.feature,
      group: f.group,
      table: f.table,
      definition: f.definition,
      adopters: counts.length,
      activeInWindow: recent.size,
      rows: counts.reduce((a, b) => a + b, 0),
      medianPerAdopter: median(counts),
      p90PerAdopter: p90(counts),
      breakdown: f.breakdown ? buildBreakdown(f.breakdown, byMethod, realTotal) : undefined,
    });
  }
  return { features, perUserCounts, perUserLastMs };
}

// ---------------------------------------------------------------------------
// RevenueCat — parse the webhook payload; production only.
// ---------------------------------------------------------------------------

/** Webhook payloads are jsonb, but a stringified column would parse as text. */
function asObject(payload) {
  if (typeof payload !== 'string') return payload || null;
  try { return JSON.parse(payload); } catch { return null; }
}

function parseRcEvent(row) {
  const p = asObject(row.payload);
  const ev = (p && p.event) || p || {};
  return {
    eventType: row.event_type,
    email: (row.app_user_id || '').toLowerCase(),
    productId: row.product_id || ev.product_id || null,
    createdAt: row.created_at,
    createdMs: toMs(row.created_at),
    environment: ev.environment || null,          // 'PRODUCTION' | 'SANDBOX'
    periodType: ev.period_type || null,           // 'TRIAL' | 'NORMAL' | 'INTRO'
    expirationMs: ev.expiration_at_ms ? Number(ev.expiration_at_ms) : null,
    isSandbox: ev.environment === 'SANDBOX',
    // RevenueCat sends price 0 for free-trial events, so this is a literal
    // "did money move" test. `price` is normalised to USD; the local-currency
    // field is only a fallback for older events that predate it.
    priceUsd: Number(ev.price ?? ev.price_in_purchased_currency ?? 0) || 0,
  };
}

/**
 * All RC events (parsed), plus per-email chronological PRODUCTION lists and
 * the latest PRODUCTION event per email. Sandbox is kept only so it can be
 * reported as a discrepancy — it can never contribute to `paidEmails`, because
 * a sandbox purchase costs nothing.
 */
async function loadRcEvents() {
  const rows = await fetchAll('revenuecat_webhook_events', 'event_type,app_user_id,product_id,created_at,payload');
  const events = rows.map(parseRcEvent).filter((e) => e.email);
  const prodByEmail = new Map();   // email -> events asc
  const sandboxEmails = new Set();
  const paidEmails = new Set();    // at least one PRODUCTION event with price > 0
  for (const e of events) {
    if (e.isSandbox) { sandboxEmails.add(e.email); continue; }
    if (e.priceUsd > 0) paidEmails.add(e.email);
    if (!prodByEmail.has(e.email)) prodByEmail.set(e.email, []);
    prodByEmail.get(e.email).push(e);
  }
  const latestProd = new Map();
  for (const [email, list] of prodByEmail) {
    list.sort((a, b) => a.createdMs - b.createdMs);
    latestProd.set(email, list[list.length - 1]);
  }
  return { events, prodByEmail, latestProd, sandboxEmails, paidEmails };
}

// ---------------------------------------------------------------------------
// Stripe — proof that money actually moved.
// ---------------------------------------------------------------------------

/** Cents on a logged invoice.payment_succeeded event, or 0. */
function invoiceAmountPaid(payload) {
  const p = asObject(payload);
  return Number(p?.data?.object?.amount_paid ?? 0) || 0;
}

/**
 * Stripe customers who have paid a non-zero invoice at least once.
 * $0 invoices — trial periods, 100%-off promo codes — are excluded by the
 * amount test, which is the whole point: they are not revenue.
 */
async function loadStripePaidCustomers() {
  const rows = await fetchAll(
    'stripe_webhook_events',
    'stripe_customer_id,payload',
    (q) => q.eq('event_type', 'invoice.payment_succeeded'),
  );
  const paid = new Set();
  for (const r of rows) {
    if (r.stripe_customer_id && invoiceAmountPaid(r.payload) > 0) paid.add(r.stripe_customer_id);
  }
  return paid;
}

/**
 * Has this account ever moved money? Either store counts, since a user can
 * subscribe on the web and on the phone. The RevenueCat side joins by email
 * (app_user_id), the Stripe side by customer id off the subscriptions row.
 */
function everPaid(email, stripeSub, rc, stripePaidCustomers) {
  if (rc.paidEmails.has(email)) return true;
  const customerId = stripeSub?.stripe_customer_id;
  return Boolean(customerId && stripePaidCustomers.has(customerId));
}

/**
 * The same test for a single account, without loading every event in the
 * system. Deliberately not built from the detail page's 50-event preview: an
 * old purchase can sit past that cut-off, and the badge must agree with the
 * bucket the overview counted this account in.
 */
async function everPaidOne(email, stripeCustomerId) {
  const [rcRows, stripeRows] = await Promise.all([
    fetchAll('revenuecat_webhook_events', 'event_type,app_user_id,product_id,created_at,payload', (q) => q.eq('app_user_id', email)),
    stripeCustomerId
      ? fetchAll('stripe_webhook_events', 'stripe_customer_id,payload', (q) => q.eq('event_type', 'invoice.payment_succeeded').eq('stripe_customer_id', stripeCustomerId))
      : Promise.resolve([]),
  ]);
  return rcRows.map(parseRcEvent).some((e) => !e.isSandbox && e.priceUsd > 0)
    || stripeRows.some((r) => invoiceAmountPaid(r.payload) > 0);
}

// ---------------------------------------------------------------------------
// Subscription state: what the app enforces + what the evidence says.
// ---------------------------------------------------------------------------

const STRIPE_LIVE = new Set(['active', 'trialing', 'past_due']);
const RC_DEAD_TYPES = new Set(['EXPIRATION', 'TRANSFER', 'SUBSCRIBER_ALIAS', 'TEST']);

/** Live entitlement evidence for a user, or null. Stripe wins if both exist. */
function liveEvidence(stripeSub, latestRcProd, nowMs) {
  if (stripeSub && STRIPE_LIVE.has(stripeSub.status)) {
    const status = stripeSub.status === 'active' ? 'paying' : stripeSub.status;
    return { source: 'stripe', status, productId: stripeSub.stripe_price_id || null };
  }
  const rc = latestRcProd;
  if (rc && !RC_DEAD_TYPES.has(rc.eventType) && rc.expirationMs && rc.expirationMs > nowMs) {
    const status = rc.periodType === 'TRIAL' ? 'trialing'
      : rc.eventType === 'CANCELLATION' ? 'canceling'
        : rc.eventType === 'BILLING_ISSUE' ? 'past_due'
          : 'paying';
    return { source: 'apple', status, productId: rc.productId, expiresAt: new Date(rc.expirationMs).toISOString() };
  }
  return null;
}

/**
 * The status the console shows. `tier` is users.tier — the thing usageService
 * enforces limits on — so it decides whether an account is premium at all.
 * Money then decides which premium bucket:
 *
 *   paying   revenue > $0 at some point AND a live subscription right now
 *   trialing live, but $0 so far by design
 *   comped   premium the app is giving away — a manual grant, an expired or
 *            sandbox-only entitlement, or a 100%-off promo. Never revenue.
 *
 * `hasPaid` is deliberately "ever paid", not "paid this period": someone on a
 * live annual plan paid ten months ago and is still a paying customer. The
 * "still" half is `evidence`, which requires an unexpired entitlement.
 *
 * Known gap, harmless today: a paid NON_RENEWING_PURCHASE carries no
 * expiration_at_ms, so liveEvidence() returns null and it would read as comped.
 * There is no lifetime SKU, so nothing hits this yet.
 */
function subscriptionState(user, evidence, hasPaid) {
  const tier = user.tier || 'free';
  if (tier === 'grandfathered') return { tier, source: 'grandfathered', status: 'grandfathered', productId: evidence?.productId || null };
  if (tier === 'premium') {
    const base = { tier, source: evidence?.source || null, productId: evidence?.productId || null, expiresAt: evidence?.expiresAt || null };
    if (!evidence) return { ...base, status: 'comped' };                        // nothing live
    if (evidence.status === 'trialing') return { ...base, status: 'trialing' }; // $0 by design
    if (!hasPaid) return { ...base, status: 'comped' };                         // live, but no money ever
    return { ...base, status: evidence.status };                                // paying | canceling | past_due
  }
  return { tier: 'free', source: null, status: 'free', productId: null };
}

/** Discrepancy rows for the "Needs attention" card. */
function subscriptionDiscrepancies(user, evidence, sandboxEmails, hasPaid) {
  const out = [];
  const tier = user.tier || 'free';
  const who = { userId: user.id, email: user.email };
  if (tier === 'premium' && !evidence) {
    out.push({ ...who, type: 'premium_without_evidence', detail: 'users.tier is premium but no live Stripe row or unexpired RevenueCat production event. Nightly IAP reconcile should downgrade; if it persists, a missed webhook.' });
  }
  if (tier === 'free' && evidence) {
    out.push({ ...who, type: 'free_with_evidence', detail: `users.tier is free but ${evidence.source} shows ${evidence.status}${evidence.expiresAt ? ` until ${evidence.expiresAt.slice(0, 10)}` : ''}. Likely a missed upgrade.` });
  }
  if (tier === 'premium' && evidence && evidence.status !== 'trialing' && !hasPaid) {
    out.push({ ...who, type: 'premium_live_but_never_paid', detail: `${evidence.source} shows a live ${evidence.status} subscription, but no PRODUCTION purchase with a price above $0 and no paid Stripe invoice. A manual grant, a 100%-off promo, or a purchase whose price never reached us.` });
  }
  if (tier === 'free' && user.is_grandfathered) {
    out.push({ ...who, type: 'grandfathered_flag_on_free_tier', detail: 'is_grandfathered=true but tier=free: the app enforces FREE limits, while tierSyncService will never downgrade this account. Decide which is intended.' });
  }
  if (sandboxEmails.has((user.email || '').toLowerCase())) {
    out.push({ ...who, type: 'sandbox_events', detail: 'Has RevenueCat SANDBOX events on a real account. They are ignored here, but this looks like a tester using a real email.' });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Streaks — engagement, not adoption.
// ---------------------------------------------------------------------------

const STREAK_BUCKETS = [
  { label: '1', min: 1, max: 1 }, { label: '2–3', min: 2, max: 3 }, { label: '4–6', min: 4, max: 6 },
  { label: '7–13', min: 7, max: 13 }, { label: '14–29', min: 14, max: 29 }, { label: '30+', min: 30, max: Infinity },
];

async function loadStreaks(realIds, keys, nowMs) {
  const [streakRows, logRows, milestoneRows] = await Promise.all([
    fetchAll('user_streaks', 'user_id,current_streak,longest_streak,last_activity_date,grace_period_expires_at,freezes_used_total', null, 'user_id'),
    fetchAll('streak_daily_log', 'user_id,date,status'),
    fetchAll('streak_milestones', 'user_id,milestone'),
  ]);
  const streaks = streakRows.filter((s) => realIds.has(s.user_id));
  const logs = logRows.filter((r) => realIds.has(r.user_id));
  const milestones = milestoneRows.filter((m) => realIds.has(m.user_id));

  const current = streaks.map((s) => s.current_streak || 0);
  const longest = streaks.map((s) => s.longest_streak || 0);
  const onStreak = current.filter((c) => c > 0);

  const distribution = STREAK_BUCKETS.map((b) => ({ label: b.label, users: longest.filter((v) => v >= b.min && v <= b.max).length }));

  const milestoneCounts = {};
  for (const m of milestones) milestoneCounts[m.milestone] = (milestoneCounts[m.milestone] || 0) + 1;

  const statusMix = {};
  const activeDaysPerUser = {};
  const activeByDay = {};
  for (const r of logs) {
    statusMix[r.status] = (statusMix[r.status] || 0) + 1;
    if (r.status === 'active' || r.status === 'restored') {
      activeDaysPerUser[r.user_id] = (activeDaysPerUser[r.user_id] || 0) + 1;
      activeByDay[r.date] = (activeByDay[r.date] || 0) + 1; // `date` is already a user-local calendar day
    }
  }
  const activeDays = Object.values(activeDaysPerUser);

  return {
    summary: {
      usersWithHistory: streaks.length,
      onStreakNow: onStreak.length,
      avgCurrentStreak: round1(mean(onStreak)),
      avgLongestStreak: round1(mean(longest)),
      longestEver: longest.length ? Math.max(...longest) : 0,
      inGrace: streaks.filter((s) => s.grace_period_expires_at && toMs(s.grace_period_expires_at) > nowMs).length,
      freezesUsed: streaks.reduce((a, s) => a + (s.freezes_used_total || 0), 0),
      avgActiveDays: round1(mean(activeDays)),
      medianActiveDays: median(activeDays),
    },
    distribution,
    milestones: Object.entries(milestoneCounts).map(([milestone, users]) => ({ milestone: Number(milestone), users })).sort((a, b) => a.milestone - b.milestone),
    statusMix,
    dailyActive: keys.map((date) => ({ date, users: activeByDay[date] || 0 })),
    launchedOn: STREAKS_LAUNCHED,
  };
}

// ---------------------------------------------------------------------------
// One snapshot per window so the pieces can never drift against each other.
// ---------------------------------------------------------------------------

async function loadSnapshot(days) {
  return cached(`snapshot:${days}`, async () => {
    const nowMs = Date.now();
    const keys = windowKeys(days, nowMs);
    const windowStartKey = keys[0];
    const users = await loadRealUsers();
    const realIds = new Set(users.map((u) => u.id));
    const [featureUsage, stripeSubs, rc, stripePaid, streaks] = await Promise.all([
      loadFeatureUsage(realIds, windowStartKey),
      // stripe_customer_id is the only join key to the logged invoice events.
      fetchAll('subscriptions', 'user_id,status,tier,stripe_customer_id,stripe_price_id,trial_start,trial_end,canceled_at,created_at'),
      loadRcEvents(),
      loadStripePaidCustomers(),
      loadStreaks(realIds, keys, nowMs),
    ]);
    return { nowMs, days, keys, windowStartKey, users, realIds, featureUsage, stripeSubs, rc, stripePaid, streaks };
  });
}

async function getOverview({ days = 30 } = {}) {
  const snap = await loadSnapshot(days);
  const { nowMs, keys, windowStartKey, users, realIds, featureUsage, stripeSubs, rc, stripePaid, streaks } = snap;
  const { features, perUserCounts, perUserLastMs } = featureUsage;
  const subByUser = new Map(stripeSubs.map((s) => [s.user_id, s]));
  const idByEmail = new Map(users.map((u) => [(u.email || '').toLowerCase(), u.id]));
  const inWindow = (v) => { const k = dayKey(v); return k !== null && k >= windowStartKey; };

  // --- Signups: calendar-day buckets; the tile is the sum of the bars. ---
  const series = {};
  for (const k of keys) series[k] = { date: k, mobile: 0, web: 0, other: 0 };
  const platformInWindow = { mobile: 0, web: 0, other: 0 };
  const platformAllTime = { mobile: 0, web: 0, other: 0 };
  let signups7 = 0;
  const key7 = shiftDay(dayKey(nowMs), -6);
  const key30 = shiftDay(dayKey(nowMs), -29);
  let signups30 = 0;
  for (const u of users) {
    const plat = u.signup_platform === 'mobile' || u.signup_platform === 'web' ? u.signup_platform : 'other';
    platformAllTime[plat]++;
    const k = dayKey(u.created_at);
    if (!k) continue;
    if (k >= key7) signups7++;
    if (k >= key30) signups30++;
    if (Object.hasOwn(series, k)) { series[k][plat]++; platformInWindow[plat]++; }
  }
  const signupSeries = keys.map((k) => series[k]);
  const signupsInWindow = signupSeries.reduce((a, d) => a + d.mobile + d.web + d.other, 0);

  // --- Activity: last_active_at blended with the latest feature write. ---
  const lastSeenMs = (u) => {
    const a = toMs(u.last_active_at);
    const b = perUserLastMs.get(u.id);
    const vals = [a, b].filter((v) => typeof v === 'number' && !Number.isNaN(v));
    return vals.length ? Math.max(...vals) : null;
  };
  const active = (ms) => users.filter((u) => { const s = lastSeenMs(u); return s !== null && nowMs - s < ms; }).length;

  // --- Subscriptions ---
  const subscriptionCounts = { paying: 0, trialing: 0, canceling: 0, past_due: 0, comped: 0, grandfathered: 0, free: 0 };
  const discrepancies = [];
  for (const u of users) {
    const email = (u.email || '').toLowerCase();
    const sub = subByUser.get(u.id);
    const evidence = liveEvidence(sub, rc.latestProd.get(email), nowMs);
    const hasPaid = everPaid(email, sub, rc, stripePaid);
    const st = subscriptionState(u, evidence, hasPaid);
    subscriptionCounts[st.status] = (subscriptionCounts[st.status] || 0) + 1;
    discrepancies.push(...subscriptionDiscrepancies(u, evidence, rc.sandboxEmails, hasPaid));
  }
  // One number, one definition: the Paying tile is the paying bucket. Canceling
  // and past due have paid before but are not paying now; trialing never has.
  const paying = subscriptionCounts.paying;

  // --- Trials / paid starts / lapses in the window (production, real users) ---
  let trialsStarted = 0, paidStarts = 0, lapsedTrial = 0, lapsedPaid = 0;
  for (const [email, list] of rc.prodByEmail) {
    if (!realIds.has(idByEmail.get(email))) continue;
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      if (!inWindow(e.createdMs)) continue;
      if (e.eventType === 'INITIAL_PURCHASE') {
        if (e.periodType === 'TRIAL') trialsStarted++; else paidStarts++;
      } else if (e.eventType === 'RENEWAL') {
        // A RENEWAL whose previous event was a TRIAL period is the trial converting to paid.
        const prev = list[i - 1];
        if (prev && prev.periodType === 'TRIAL' && e.periodType !== 'TRIAL') paidStarts++;
      } else if (e.eventType === 'EXPIRATION') {
        if (e.periodType === 'TRIAL') lapsedTrial++; else lapsedPaid++;
      }
    }
  }
  for (const s of stripeSubs) {
    if (!realIds.has(s.user_id)) continue;
    if (inWindow(s.created_at)) paidStarts++;
    if (s.canceled_at && inWindow(s.canceled_at)) lapsedPaid++;
  }

  const activated = users.filter((u) => {
    const c = perUserCounts.get(u.id);
    return c && Object.keys(c).some((f) => !SETUP_FEATURES.includes(f));
  }).length;

  const pendingDeletion = users.filter((u) => u.deletion_status).length;

  return {
    generatedAt: new Date(nowMs).toISOString(),
    windowDays: days,
    windowStart: windowStartKey,
    windowEnd: keys[keys.length - 1],
    timezone: ADMIN_TZ,
    exclusions: {
      emails: [...INTERNAL_EMAILS],
      domains: [...INTERNAL_DOMAINS],
      rule: 'Excluded: any email containing "test", the internal addresses and reserved domains listed here, admins, accounts flagged users.is_test, and the system user.',
    },
    assumptions: [
      `Days are calendar days in ${ADMIN_TZ}; the window is the last ${days} days including today, and tiles are sums of the same buckets the charts draw.`,
      `Active = a real user seen in the last 1/7/30 × 24h, where "seen" is the later of users.last_active_at (API activity, tracked since ${LAST_ACTIVE_TRACKED_SINCE}) and their latest feature write.`,
      'Paying = a real user with a live subscription right now AND at least one payment above $0 — a RevenueCat PRODUCTION event with price > 0, or a Stripe invoice.payment_succeeded with amount_paid > 0. Trialing, canceling and past due are counted separately and are not revenue; premium with no payment behind it is "comped"; grandfathered is lifetime-free.',
      'RevenueCat SANDBOX events are ignored everywhere except the sandbox discrepancy row.',
      'Feature adoption counts things a user chose to do; streaks (a side-effect log) have their own card, and guided tour / push token are listed under Setup and excluded from "Activated".',
    ],
    totals: {
      realUsers: users.length,
      pendingDeletion,
      activated,
      signups7d: signups7,
      signups30d: signups30,
      signupsInWindow,
      active1d: active(864e5),
      active7d: active(7 * 864e5),
      active30d: active(30 * 864e5),
      lastActiveTracked: users.some((u) => u.last_active_at),
      lastActiveTrackedSince: LAST_ACTIVE_TRACKED_SINCE,
    },
    signupsByPlatform: platformInWindow,
    signupsByPlatformAllTime: platformAllTime,
    signupSeries,
    subscriptions: {
      counts: subscriptionCounts,
      paying,
      trialsStarted,
      paidStarts,
      lapsed: { trial: lapsedTrial, paid: lapsedPaid },
      discrepancies,
    },
    streaks,
    features: features
      .filter((f) => !f.error)
      .map((f) => ({ ...f, adoptionPct: users.length ? Math.round((100 * f.adopters) / users.length) : 0, activePct: users.length ? Math.round((100 * f.activeInWindow) / users.length) : 0 }))
      .sort((a, b) => (a.group === b.group ? b.adopters - a.adopters : a.group === 'feature' ? -1 : 1)),
    featureErrors: features.filter((f) => f.error),
  };
}

async function listUsers({ search = '', sort = 'created_at', dir = 'desc', page = 1, pageSize = 50 } = {}) {
  const snap = await loadSnapshot(30);
  const { nowMs, users, featureUsage, stripeSubs, rc, stripePaid } = snap;
  const streakRows = await fetchAll('user_streaks', 'user_id,current_streak,longest_streak,last_activity_date', null, 'user_id');
  const subByUser = new Map(stripeSubs.map((s) => [s.user_id, s]));
  const streakByUser = new Map(streakRows.map((s) => [s.user_id, s]));

  const q = search.trim().toLowerCase();
  const rows = users
    .filter((u) => !q || (u.email || '').toLowerCase().includes(q) || (u.first_name || '').toLowerCase().includes(q) || u.id === q)
    .map((u) => {
      const email = (u.email || '').toLowerCase();
      const sub = subByUser.get(u.id);
      const evidence = liveEvidence(sub, rc.latestProd.get(email), nowMs);
      return {
        id: u.id,
        email: u.email,
        firstName: u.first_name,
        createdAt: u.created_at,
        signupPlatform: u.signup_platform,
        tier: u.tier,
        lastActiveAt: u.last_active_at,
        deletionStatus: u.deletion_status,
        subscription: subscriptionState(u, evidence, everPaid(email, sub, rc, stripePaid)),
        streak: streakByUser.get(u.id) || null,
        features: featureUsage.perUserCounts.get(u.id) || {},
      };
    });

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
  // Select is_test too: without it the `excluded` badge below can never fire
  // the flag branch, so an account excluded from every aggregate would show as
  // "not excluded" on its own detail page.
  let user = null;
  {
    const withFlag = await sb.from('users').select(USER_COLUMNS_WITH_IS_TEST).eq('id', userId).maybeSingle();
    if (withFlag.error && /is_test/.test(withFlag.error.message)) {
      const fallback = await sb.from('users').select(USER_COLUMNS).eq('id', userId).maybeSingle();
      user = fallback.data;
    } else {
      user = withFlag.data;
    }
  }
  if (!user) return null;
  const email = (user.email || '').toLowerCase();

  const [subRes, rcRes, streakRes, onboardingRes, usageRes, liveRc] = await Promise.all([
    sb.from('subscriptions').select('*').eq('user_id', userId).maybeSingle(),
    sb.from('revenuecat_webhook_events').select('event_type,app_user_id,product_id,created_at,payload,processed,error_message').eq('app_user_id', email).order('created_at', { ascending: false }).limit(50),
    sb.from('user_streaks').select('*').eq('user_id', userId).maybeSingle(),
    sb.from('user_onboarding_data').select('primary_goal,household_size,weekly_budget,onboarding_completed,created_at').eq('user_id', userId).maybeSingle(),
    sb.from('usage_limits').select('*').eq('user_id', userId).maybeSingle(),
    revenueCatService.getSubscriberInfo(user.email).catch(() => null),
  ]);

  const rcEvents = (rcRes.data || []).map((row) => ({ ...parseRcEvent(row), processed: row.processed, error_message: row.error_message }));
  const latestProd = rcEvents.find((e) => !e.isSandbox) || null;
  const evidence = liveEvidence(subRes.data, latestProd, Date.now());
  const hasPaid = await everPaidOne(email, subRes.data?.stripe_customer_id || null);

  const counts = {};
  await Promise.all(FEATURE_TABLES.map(async (f) => {
    let q = sb.from(f.table).select('*', { count: 'exact', head: true }).eq(f.user, userId);
    if (f.filter) q = f.filter(q);
    const { count } = await q;
    counts[f.feature] = count || 0;
  }));

  return {
    user: {
      id: user.id, email: user.email, firstName: user.first_name, createdAt: user.created_at,
      tier: user.tier, isGrandfathered: user.is_grandfathered, signupPlatform: user.signup_platform,
      lastActiveAt: user.last_active_at, deletionStatus: user.deletion_status, excluded: isExcludedUser(user),
    },
    subscription: subscriptionState(user, evidence, hasPaid),
    evidence,
    hasPaid,
    discrepancies: subscriptionDiscrepancies(user, evidence, new Set(rcEvents.some((e) => e.isSandbox) ? [email] : []), hasPaid),
    stripeSubscription: subRes.data || null,
    revenueCatEvents: rcEvents.map((e) => ({
      event_type: e.eventType, product_id: e.productId, created_at: e.createdAt,
      period_type: e.periodType, environment: e.environment,
      expires_at: e.expirationMs ? new Date(e.expirationMs).toISOString() : null,
      processed: e.processed, error_message: e.error_message,
    })),
    revenueCatLive: liveRc ? { entitlements: liveRc.entitlements, subscriptions: liveRc.subscriptions, firstSeen: liveRc.first_seen, lastSeen: liveRc.last_seen } : null,
    streak: streakRes.data || null,
    onboarding: onboardingRes.data || null,
    usageLimits: usageRes.data || null,
    featureCounts: counts,
  };
}

module.exports = { getOverview, listUsers, getUserDetail, isExcludedUser, exclusionReason, loadRealUsers, ADMIN_TZ, dayKey };
