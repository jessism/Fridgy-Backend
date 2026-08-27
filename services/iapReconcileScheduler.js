/**
 * IAP Reconcile Scheduler
 * Runs nightly to downgrade Apple/RevenueCat subscribers whose subscription lapsed
 * but whose users.tier is still premium - the case a missed or unhandled webhook
 * (e.g. a TRANSFER to another account) leaves behind.
 *
 * Candidates come from the iap_reconcile_candidates view (migration 077); every one
 * is confirmed against the live RevenueCat API before anything is written, and the
 * whole run aborts on any API error so an outage can never mass-downgrade payers.
 * Defaults to dry-run: set IAP_RECONCILE_MODE=apply to write.
 */

const cron = require('node-cron');
const { getServiceClient } = require('../config/supabase');
const revenueCatService = require('./revenueCatService');
const tierSyncService = require('./tierSyncService');
const { trackEvent } = require('../config/posthog');

const TAG = '[IAPReconcile]';

function getConfig() {
  return {
    mode: process.env.IAP_RECONCILE_MODE === 'apply' ? 'apply' : 'dry-run',
    graceHours: Number(process.env.IAP_RECONCILE_GRACE_HOURS || 48),
    maxDowngrades: Number(process.env.IAP_RECONCILE_MAX_DOWNGRADES || 3),
    maxRatio: Number(process.env.IAP_RECONCILE_MAX_DOWNGRADE_RATIO || 0.2),
    ratioMinPopulation: 10,
  };
}

/**
 * Run one reconcile pass.
 * @param {Object} [options]
 * @param {'dry-run'|'apply'} [options.mode] - overrides IAP_RECONCILE_MODE
 * @param {string} [options.only] - restrict to a single email
 * @returns {Promise<Object>} run summary
 */
async function reconcile({ mode, only = null } = {}) {
  const config = getConfig();
  const runMode = mode || config.mode;
  const startedAt = new Date().toISOString();
  const summary = {
    mode: runMode, startedAt, population: 0, candidates: 0,
    active: 0, expired: 0, none: 0, errors: 0,
    downgraded: 0, skipped: 0, aborted: false, abortReason: null,
  };

  if (!process.env.REVENUECAT_SECRET_API_KEY) {
    return finish(summary, 'rc_not_configured');
  }

  const supabase = getServiceClient();

  // PHASE 1: candidates - stored expiry older than the grace window, or none on record
  const cutoff = new Date(Date.now() - config.graceHours * 3600 * 1000).toISOString();
  let query = supabase
    .from('iap_reconcile_candidates')
    .select('*')
    .or(`latest_expiration_at.lt.${cutoff},latest_expiration_at.is.null`);
  if (only) query = query.eq('email', only);

  const [{ data: rows, error }, { count: population, error: countError }] = await Promise.all([
    query,
    supabase.from('iap_reconcile_candidates').select('*', { count: 'exact', head: true }),
  ]);
  if (error) return finish(summary, `query_failed: ${error.message}`);
  if (countError) console.warn(`${TAG} Population count failed:`, countError.message);

  summary.population = population || 0;
  summary.candidates = rows.length;
  console.log(`${TAG} ${rows.length} candidate(s) of ${summary.population} unbacked premium user(s), grace ${config.graceHours}h, mode=${runMode}`);

  // PHASE 2: confirm with RevenueCat - no writes yet
  const decisions = [];
  for (const row of rows) {
    const reason = row.latest_expiration_at
      ? `stale_expiry (${row.latest_expiry_event_type} exp ${row.latest_expiration_at})`
      : `no_expiry_on_record (${row.event_count} events)`;

    const rc = await revenueCatService.getEntitlementState(row.email);

    if (rc.state === 'error') {
      summary.errors++;
      console.error(`${TAG} ${row.email}: RC lookup failed (http ${rc.httpStatus}) ${rc.error || ''}`);
    } else if (rc.state === 'active') {
      summary.active++;
      console.log(`${TAG} ${row.email}: RC active until ${rc.expiresAt}${rc.isSandbox ? ' [SANDBOX]' : ''} - keeping premium (${reason}; webhook gap?)`);
    } else {
      summary[rc.state]++;
      decisions.push({ row, rc, reason: `${reason}; RC=${rc.state}` });
    }
  }

  // PHASE 3: safety gates
  if (summary.errors > 0) {
    summary.aborted = true;
    summary.abortReason = `${summary.errors} RC error(s)`;
  } else if (decisions.length > config.maxDowngrades) {
    summary.aborted = true;
    summary.abortReason = `${decisions.length} downgrades > max ${config.maxDowngrades}`;
  } else if (summary.population >= config.ratioMinPopulation
             && decisions.length / summary.population > config.maxRatio) {
    summary.aborted = true;
    summary.abortReason = `ratio ${(decisions.length / summary.population).toFixed(2)} > ${config.maxRatio}`;
  }

  // PHASE 4: apply, or say what would happen
  for (const d of decisions) {
    if (summary.aborted || runMode !== 'apply') {
      console.warn(`${TAG} WOULD downgrade ${d.row.email} (${d.reason})${summary.aborted ? ' - SKIPPED, run aborted' : ''}`);
      continue;
    }
    const r = await tierSyncService.downgradeUserIfEligible(d.row.email, { reason: `iap_reconcile: ${d.reason}` });
    if (r.status === 'downgraded') {
      summary.downgraded++;
      await trackEvent(r.userId, 'IAP Reconcile Downgrade', {
        email: d.row.email, reason: d.reason, rcState: d.rc.state,
      });
    } else if (r.status === 'error') {
      summary.errors++;
      console.error(`${TAG} ${d.row.email}: downgrade failed: ${r.error}`);
    } else {
      summary.skipped++;
      console.log(`${TAG} ${d.row.email}: skipped at write time (${r.status})`);
    }
  }

  return finish(summary);
}

function finish(summary, abortReason) {
  if (abortReason) {
    summary.aborted = true;
    summary.abortReason = abortReason;
  }
  const line = `${TAG} SUMMARY run=${summary.startedAt} mode=${summary.mode} population=${summary.population} candidates=${summary.candidates} active=${summary.active} expired=${summary.expired} none=${summary.none} errors=${summary.errors} downgraded=${summary.downgraded} skipped=${summary.skipped} aborted=${summary.aborted}${summary.abortReason ? ` reason="${summary.abortReason}"` : ''}`;
  if (summary.aborted) {
    console.error(`${TAG} 🚨 RUN ABORTED - ${summary.abortReason}`);
    console.error(line);
    trackEvent('system', 'IAP Reconcile Aborted', summary).catch(() => {});
  } else {
    console.log(line);
  }
  return summary;
}

/**
 * Start the IAP reconcile scheduler
 * Runs daily at 3:15 AM (server time) - off the :00/:30 streak sweeps, after the
 * 2:00 AM account deletion run, well before the 9:00 AM emails
 */
function startScheduler() {
  const cronSchedule = '15 3 * * *';

  console.log(`${TAG} Starting IAP reconcile scheduler (runs daily at 3:15 AM, mode=${getConfig().mode})`);

  cron.schedule(cronSchedule, async () => {
    console.log(`${TAG} Scheduled task running...`);
    try {
      await reconcile();
    } catch (error) {
      console.error(`${TAG} Unhandled error:`, error);
    }
  });

  console.log(`${TAG} Scheduler initialized successfully`);
}

/**
 * Manual trigger for testing
 */
async function runNow(options) {
  console.log(`${TAG} Manual trigger requested`);
  return reconcile(options);
}

module.exports = {
  startScheduler,
  reconcile,
  runNow,
};
