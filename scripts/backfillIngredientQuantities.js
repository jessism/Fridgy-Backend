// One-off repair for recipes whose ingredients came through the JSON-LD
// shortcut before it learned to split "1 lb mild italian sausage" into
// amount / unit / name. Those rows have an exact shape: every ingredient has
// amount null, unit '', an id, and no nameEn. Recipes with a few genuine
// "salt to taste" lines never match, because the rest carry amounts.
//
// Dry run by default — nothing is written without --apply.
// Run from the Backend directory:
//   node scripts/backfillIngredientQuantities.js                  # report only
//   node scripts/backfillIngredientQuantities.js --user a@b.com   # one account
//   node scripts/backfillIngredientQuantities.js --id <uuid>
//   node scripts/backfillIngredientQuantities.js --apply --limit 5
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { getServiceClient } = require('../config/supabase');
const RecipeAIExtractor = require('../services/recipeAIExtractor');

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const APPLY = flag('--apply');
const LIMIT = parseInt(opt('--limit'), 10) || Infinity;
const EMAIL = opt('--user');
const ID = opt('--id');

const isRawLine = (ing) =>
  ing && ing.amount === null && ing.unit === '' && 'id' in ing && !('nameEn' in ing);
const needsRepair = (r) =>
  Array.isArray(r.extendedIngredients) &&
  r.extendedIngredients.length > 0 &&
  r.extendedIngredients.every(isRawLine);
const show = (ing) => `${ing.amount ?? ''} ${ing.unit || ''} ${ing.name}`.replace(/\s+/g, ' ').trim();

(async () => {
  const supabase = getServiceClient();
  const recipeAI = new RecipeAIExtractor();

  let userId = null;
  if (EMAIL) {
    const { data: users, error } = await supabase
      .from('users').select('id,email').eq('email', EMAIL).limit(1);
    if (error) throw error;
    if (!users?.length) { console.log(`No user found for ${EMAIL}`); return; }
    userId = users[0].id;
  }

  // Page through: the two broken shapes can't be expressed as one PostgREST
  // filter, and the default select caps at 1000 rows anyway.
  const PAGE = 500;
  const candidates = [];
  let scanned = 0;
  for (let from = 0; ; from += PAGE) {
    let q = supabase
      .from('saved_recipes')
      .select('id,user_id,title,updated_at,extendedIngredients')
      .order('created_at', { ascending: true })
      .range(from, from + PAGE - 1);
    if (userId) q = q.eq('user_id', userId);
    if (ID) q = q.eq('id', ID);
    const { data, error } = await q;
    if (error) throw error;
    scanned += data.length;
    candidates.push(...data.filter(needsRepair));
    if (data.length < PAGE) break;
  }

  console.log(`${APPLY ? 'APPLY' : 'DRY RUN'} — scanned ${scanned}, ${candidates.length} recipe(s) with raw ingredient lines`);

  let repaired = 0, skipped = 0, conflicts = 0;
  for (const row of candidates) {
    if (repaired >= LIMIT) break;
    console.log(`\n— ${row.title} (${row.id})`);

    const lines = row.extendedIngredients.map((ing) => ing.original || ing.name);
    const structured = await recipeAI.structureIngredientLines(lines, `saved_recipes/${row.id}`);
    // A chunk the model got wrong comes back as raw lines, which carry no
    // nameEn key at all; a structured item always has one, even if null.
    const fellBack = structured.some((ing) => !('nameEn' in ing));

    row.extendedIngredients.forEach((ing, i) =>
      console.log(`   ${show(ing).padEnd(48)} →  ${show(structured[i])}`));

    if (fellBack) { console.log('   ⏭  model output rejected; leaving row untouched'); skipped++; continue; }
    if (!APPLY) { repaired++; continue; }

    // Only write over the version we read; the app edits this column too
    const { data: upd, error } = await supabase
      .from('saved_recipes')
      .update({ extendedIngredients: structured, updated_at: new Date().toISOString() })
      .eq('id', row.id)
      .eq('updated_at', row.updated_at)
      .select('id');
    if (error) { console.log(`   ❌ ${error.message}`); skipped++; continue; }
    if (!upd?.length) { console.log('   ⏭  edited since it was read; skipped'); conflicts++; continue; }
    console.log('   ✅ written');
    repaired++;
    await new Promise((r) => setTimeout(r, 100));
  }

  console.log('\n' + '='.repeat(60));
  console.log(`${APPLY ? 'Repaired' : 'Would repair'}: ${repaired}   skipped: ${skipped}   edit conflicts: ${conflicts}`);
  if (!APPLY && repaired) console.log('Re-run with --apply to write.');
})().catch((e) => { console.error(e); process.exit(1); });
