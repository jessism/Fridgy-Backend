/**
 * Cron jobs for the Reddit opportunities monitor (America/Los_Angeles):
 *   ingest – every 15 min: mailbox → parse → score → instant alerts
 *   digest – daily morning email with the mid-score finds
 * Same shape as the outreach scheduler: each job logs a JSON summary and a
 * failure in one run never stops the next.
 */
const cron = require('node-cron');
const config = require('./config');
const { ingest } = require('./ingest');
const { scorePending } = require('./score');
const { sendInstantAlerts, sendDigest } = require('./alert');

const TAG = '[Reddit]';

/** The whole 15-minute cycle; also the console's manual "ingest" job. */
async function runIngestCycle() {
  const ingested = await ingest();
  if (ingested.skipped) return ingested;
  const scored = await scorePending();
  const alerts = await sendInstantAlerts();
  return { ...ingested, ...scored, alertsSent: alerts.sent };
}

function safe(name, fn) {
  return async () => {
    try {
      const out = await fn();
      console.log(`${TAG} ${name}:`, JSON.stringify(out ?? {}));
    } catch (e) {
      console.error(`${TAG} ${name} failed:`, e.message);
    }
  };
}

function start() {
  if (!config.enabled) {
    console.log(`${TAG} monitor disabled (REDDIT_MONITOR_ENABLED)`);
    return;
  }
  const tz = { timezone: config.TIMEZONE };
  cron.schedule(config.cron.ingest, safe('ingest cycle', runIngestCycle), tz);
  cron.schedule(config.cron.digest, safe('digest', sendDigest), tz);
  console.log(`${TAG} scheduler running (${config.TIMEZONE}): ingest ${config.cron.ingest}, digest ${config.cron.digest}; mailbox ${config.alertMailbox}`);
}

module.exports = { start, runIngestCycle, sendDigest };
