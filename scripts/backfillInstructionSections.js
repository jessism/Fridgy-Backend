// One-off repair for recipes whose instructions were saved as several named
// sections. Every client renders only analyzedInstructions[0].steps, so those
// recipes showed just their first section. Each row is rewritten with
// mergeInstructionSections(), the same rule new imports now go through:
// one step per titled block, long numbered blocks kept as-is.
//
// Single-group rows are never touched. updated_at, user_edited and
// original_snapshot are left alone.
//
// Dry run by default — nothing is written without --apply.
// Run from the Backend directory:
//   node scripts/backfillInstructionSections.js                # report only
//   node scripts/backfillInstructionSections.js --id <uuid>
//   node scripts/backfillInstructionSections.js --apply --limit 5
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { getServiceClient } = require('../config/supabase');
const { mergeInstructionSections } = require('../middleware/validation');

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const APPLY = flag('--apply');
const LIMIT = parseInt(opt('--limit'), 10) || Infinity;
const ID = opt('--id');

const stepCount = (groups) => groups.reduce((n, g) => n + (g?.steps?.length || 0), 0);

(async () => {
  const supabase = getServiceClient();

  // jsonb_array_length isn't expressible as a PostgREST filter; page through.
  const PAGE = 500;
  const candidates = [];
  for (let from = 0; ; from += PAGE) {
    let query = supabase
      .from('saved_recipes')
      .select('id, user_id, title, analyzedInstructions')
      .order('created_at', { ascending: true })
      .range(from, from + PAGE - 1);
    if (ID) query = query.eq('id', ID);
    const { data, error } = await query;
    if (error) throw error;
    candidates.push(...data.filter((r) =>
      Array.isArray(r.analyzedInstructions) && r.analyzedInstructions.length > 1));
    if (data.length < PAGE) break;
  }

  console.log(`${candidates.length} recipe(s) with more than one instruction section\n`);

  let repaired = 0;
  for (const recipe of candidates.slice(0, LIMIT)) {
    const before = recipe.analyzedInstructions;
    const after = mergeInstructionSections(before);
    const visibleBefore = before[0]?.steps?.length || 0;

    console.log(`── ${recipe.id}  "${recipe.title}"`);
    console.log(`   before: ${before.length} sections, ${stepCount(before)} steps (app showed ${visibleBefore})`);
    console.log(`   after:  ${after[0].steps.length} steps`);
    after[0].steps.forEach((s) => console.log(`     ${s.number}. ${s.step}`));
    console.log('');

    if (APPLY) {
      const { error } = await supabase
        .from('saved_recipes')
        .update({ analyzedInstructions: after })
        .eq('id', recipe.id)
        .eq('user_id', recipe.user_id);
      if (error) { console.error(`   ✗ update failed: ${error.message}`); continue; }
    }
    repaired++;
  }

  console.log(`${APPLY ? 'Repaired' : 'Would repair'} ${repaired} recipe(s).`);
  if (!APPLY && repaired) console.log('Re-run with --apply to write.');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
