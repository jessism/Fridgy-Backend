/**
 * Import Job Sweeper
 *
 * Async import jobs run as in-process promises with no queue. If the server
 * restarts, redeploys, or is OOM-killed mid-extraction, the job's promise dies
 * with the process but its import_jobs row stays 'processing' forever — the
 * app polls it indefinitely and the user never hears back.
 *
 * This sweeper is the only recovery for those orphans: on boot and every
 * 5 minutes it fails out any 'processing' row older than STALE_AFTER_MINUTES.
 * (The in-process deadline in routes/recipes.js can't cover this case — it
 * dies with the process too.)
 *
 * No push notification is sent here: the orphaned job may be arbitrarily old,
 * and a late "Import failed" push for something the user tried hours ago is
 * worse than the app simply showing the failed status on next poll.
 */

const { getServiceClient } = require('../config/supabase');

const SWEEP_INTERVAL_MS = 5 * 60 * 1000;
// Comfortably above the 5-minute in-process job deadline, so the sweeper only
// ever catches jobs whose process died — never a job that's still running.
const STALE_AFTER_MINUTES = 15;

class ImportJobSweeper {
  constructor() {
    this.timer = null;
  }

  async sweep() {
    try {
      const supabase = getServiceClient();
      const cutoff = new Date(Date.now() - STALE_AFTER_MINUTES * 60 * 1000).toISOString();

      const { data, error } = await supabase
        .from('import_jobs')
        .update({
          status: 'failed',
          error: 'Import was interrupted. Please try again.',
          completed_at: new Date().toISOString(),
        })
        .eq('status', 'processing')
        .lt('created_at', cutoff)
        .select('id');

      if (error) {
        console.error('[ImportJobSweeper] Sweep failed:', error.message);
        return;
      }
      if (data && data.length > 0) {
        console.warn(`[ImportJobSweeper] Failed out ${data.length} orphaned job(s):`, data.map(j => j.id).join(', '));
      }
    } catch (err) {
      console.error('[ImportJobSweeper] Sweep error:', err.message);
    }
  }

  start() {
    if (this.timer) return;
    this.sweep(); // catch orphans from the restart that just happened
    this.timer = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

module.exports = new ImportJobSweeper();
