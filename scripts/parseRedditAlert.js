/**
 * Check the F5Bot email parser against a saved alert, before trusting the cron:
 *   node scripts/parseRedditAlert.js path/to/saved-email.txt
 * (In Gmail: ⋮ → "Show original" → copy the plain-text body into a file, or
 * just copy the visible body text.)
 */
const fs = require('fs');
const { parseAlertEmail } = require('../services/redditOpportunities/parser');

const file = process.argv[2];
if (!file) {
  console.error('Usage: node scripts/parseRedditAlert.js <saved-email.txt>');
  process.exit(1);
}

const hits = parseAlertEmail(fs.readFileSync(file, 'utf8'));
console.log(`${hits.length} hit(s)\n`);
for (const h of hits) {
  const { raw_block, ...rest } = h;
  console.log(JSON.stringify(rest, null, 2));
}
if (!hits.length) {
  console.log('No hits parsed — check that the file contains reddit.com/r/<sub>/comments/ URLs.');
}
