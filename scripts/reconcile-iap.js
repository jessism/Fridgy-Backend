#!/usr/bin/env node
/**
 * Run the IAP reconcile sweep by hand.
 *
 * Usage: node scripts/reconcile-iap.js [--apply] [--grace-hours N] [--only <email>]
 *
 * Default is dry-run: prints "WOULD downgrade" lines and writes nothing.
 * Exit code 2 means the run aborted (RevenueCat errors or too many downgrades).
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

if (flag('--grace-hours')) process.env.IAP_RECONCILE_GRACE_HOURS = flag('--grace-hours');
const mode = args.includes('--apply') ? 'apply' : 'dry-run';

// Requiring the scheduler does not start cron; only startScheduler() does
require('../services/iapReconcileScheduler')
  .reconcile({ mode, only: flag('--only') })
  .then((summary) => process.exit(summary.aborted ? 2 : 0))
  .catch((error) => {
    console.error('❌ Fatal:', error.message);
    process.exit(1);
  });
