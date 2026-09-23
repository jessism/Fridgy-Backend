// Manual check for RecipeAIExtractor.structureIngredientLines — the split of
// JSON-LD ingredient lines into amount / unit / name. The first section calls
// the live model; the rest stub callAI so they run offline and deterministically.
//   node test-ingredient-structuring.js
require('dotenv').config();
const assert = require('node:assert/strict');
const RecipeAIExtractor = require('./services/recipeAIExtractor');

// The exact lines stored for the recipe that surfaced the bug (2026-09-21)
const GNOCCHI = [
  '1  lb  mild italian sausage', '1   yellow onion', '2  cups  chopped fresh spinach',
  '1-2 tbsp minced garlic', '2 cups beef or chicken bone broth', '2 cups heavy cream',
  '3 oz grated parmesean cheese', '1/2 tsp salt', '1 tsp pepper', '1 tsp italian seasoning',
  '1 tsp oregano', '1 tsp parsley', '1 tsp garlic & onion powder',
  '1 tsp crushed red peppers (optional)', '16 oz dry gnocchi pasta', '1 tbsp tomato paste',
];

const quiet = () => { const log = console.log; console.log = () => {}; return () => { console.log = log; }; };

(async () => {
  let passed = 0;
  const ok = (msg) => { passed++; console.log(`  ✅ ${msg}`); };

  // ---- 1. Live model on the real lines ----
  console.log('\n1. live model, 16 gnocchi lines');
  const live = new RecipeAIExtractor();
  const restore = quiet();
  const out = await live.structureIngredientLines(GNOCCHI, 'test');
  restore();
  assert.equal(out.length, GNOCCHI.length, 'same number of lines out');
  out.forEach((ing, i) => console.log(`     ${GNOCCHI[i].padEnd(40)} → ${ing.amount ?? '·'} ${ing.unit || '·'} | ${ing.name} | ${ing.nameEn}`));
  const byOrig = Object.fromEntries(out.map((i) => [i.original, i]));
  const expect = (orig, amount, unit, name) => {
    const got = byOrig[orig];
    assert.ok(got, `row for "${orig}"`);
    assert.equal(got.amount, amount, `${orig}: amount`);
    assert.equal((got.unit || '').toLowerCase(), unit, `${orig}: unit`);
    assert.equal(got.name.toLowerCase(), name, `${orig}: name`);
    ok(`"${orig}" → ${amount} ${unit} ${name}`);
  };
  expect('1 lb mild italian sausage', 1, 'lb', 'mild italian sausage');
  expect('1-2 tbsp minced garlic', 1.5, 'tbsp', 'minced garlic');
  expect('1/2 tsp salt', 0.5, 'tsp', 'salt');
  expect('1 yellow onion', 1, '', 'yellow onion');
  assert.ok(out.every((i) => 'nameEn' in i), 'every item carries nameEn');
  ok('every item carries nameEn');

  // ---- 2. Idempotent: AI-shaped ingredients are left alone, no call made ----
  console.log('\n2. ensureStructuredIngredients is a no-op on structured input');
  const stub = new RecipeAIExtractor();
  let calls = 0;
  stub.callAI = async () => { calls++; throw new Error('should not be called'); };
  const aiShaped = { extendedIngredients: [{ name: 'flour', amount: 2, unit: 'cups', nameEn: 'flour', original: '2 cups flour' }] };
  await stub.ensureStructuredIngredients(aiShaped);
  assert.equal(calls, 0);
  assert.equal(aiShaped.extendedIngredients[0].amount, 2);
  ok('no call, no change');

  // ---- 3. Chunking: 30 lines → 2 calls, 30 out, ids 1..30 ----
  console.log('\n3. chunking at 25');
  calls = 0;
  stub.callAI = async (prompt) => {
    calls++;
    const n = parseInt(prompt.match(/exactly (\d+) lines/)[1], 10);
    return JSON.stringify({ ingredients: Array.from({ length: n }, (_, i) => ({ amount: i + 1, unit: 'g', name: `item ${i + 1}`, nameEn: 'item' })) });
  };
  const thirty = Array.from({ length: 30 }, (_, i) => `${i + 1} g item ${i + 1}`);
  const r30 = await stub.structureIngredientLines(thirty);
  assert.equal(calls, 2);
  assert.equal(r30.length, 30);
  assert.deepEqual(r30.map((i) => i.id), thirty.map((_, i) => i + 1));
  assert.equal(r30[29].original, '30 g item 30');
  ok('2 calls, 30 items, ids 1..30, original preserved');

  // ---- 4. Wrong count → raw-line fallback, nothing invented ----
  console.log('\n4. short response falls back to raw lines');
  stub.callAI = async () => JSON.stringify({ ingredients: [{ amount: 1, unit: 'lb', name: 'x' }] });
  const restore2 = quiet();
  const fb = await stub.structureIngredientLines(['1 lb sausage', '2 cups spinach']);
  restore2();
  assert.deepEqual(fb, [
    { id: 1, original: '1 lb sausage', name: '1 lb sausage', amount: null, unit: '' },
    { id: 2, original: '2 cups spinach', name: '2 cups spinach', amount: null, unit: '' },
  ]);
  ok('fallback shape, no nameEn key');

  // ---- 5. No quantities anywhere → no call at all ----
  console.log('\n5. lines without quantities skip the model');
  calls = 0;
  stub.callAI = async () => { calls++; return '{}'; };
  const none = await stub.structureIngredientLines(['salt', 'pepper', 'olive oil']);
  assert.equal(calls, 0);
  assert.equal(none[0].name, 'salt');
  ok('no call');

  console.log(`\n${passed} checks passed`);
})().catch((e) => { console.error('\n❌', e.message); process.exit(1); });
