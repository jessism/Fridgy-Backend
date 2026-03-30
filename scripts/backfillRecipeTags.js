/**
 * Backfill Script: Recipe Tags
 *
 * This script generates AI tags for all existing recipes in the database
 * that don't have tags yet. It uses the same tag generation logic as
 * the main API to ensure consistency.
 *
 * Usage:
 *   node scripts/backfillRecipeTags.js
 *
 * The script will:
 * 1. Fetch all recipes without tags
 * 2. Generate AI tags for each recipe
 * 3. Update the database with generated tags
 * 4. Log progress and results
 */

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const { generateRecipeTags } = require('../services/recipeTagService');

// Initialize Supabase with service key for admin access
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

async function backfillRecipeTags() {
  console.log('='.repeat(60));
  console.log('Recipe Tags Backfill Script');
  console.log('='.repeat(60));
  console.log(`Started at: ${new Date().toISOString()}\n`);

  try {
    // Fetch all recipes without tags (tags is null or empty array)
    console.log('📥 Fetching recipes without tags...');
    const { data: recipes, error: fetchError } = await supabase
      .from('saved_recipes')
      .select('*')
      .or('tags.is.null,tags.eq.[]');

    if (fetchError) {
      console.error('❌ Error fetching recipes:', fetchError);
      process.exit(1);
    }

    if (!recipes || recipes.length === 0) {
      console.log('✅ All recipes already have tags! Nothing to do.');
      process.exit(0);
    }

    console.log(`Found ${recipes.length} recipes to backfill\n`);

    let processed = 0;
    let failed = 0;
    const failedRecipes = [];

    // Process each recipe
    for (let i = 0; i < recipes.length; i++) {
      const recipe = recipes[i];
      const progress = `[${i + 1}/${recipes.length}]`;

      try {
        // Generate tags
        const tags = generateRecipeTags(recipe);

        if (tags.length === 0) {
          console.log(`${progress} ⚠️  ${recipe.title} - No tags generated (skipping)`);
          continue;
        }

        // Update recipe with generated tags
        const { error: updateError } = await supabase
          .from('saved_recipes')
          .update({
            tags,
            updated_at: new Date().toISOString()
          })
          .eq('id', recipe.id);

        if (updateError) {
          console.error(`${progress} ❌ ${recipe.title} - Update failed:`, updateError.message);
          failed++;
          failedRecipes.push({ id: recipe.id, title: recipe.title, error: updateError.message });
        } else {
          const tagNames = tags.map(t => t.name).join(', ');
          console.log(`${progress} ✅ ${recipe.title} - Added ${tags.length} tags: ${tagNames}`);
          processed++;
        }

        // Rate limiting - wait 100ms between updates to avoid overloading the database
        await new Promise(resolve => setTimeout(resolve, 100));

      } catch (err) {
        console.error(`${progress} ❌ ${recipe.title} - Processing error:`, err.message);
        failed++;
        failedRecipes.push({ id: recipe.id, title: recipe.title, error: err.message });
      }
    }

    // Summary
    console.log('\n' + '='.repeat(60));
    console.log('Backfill Summary');
    console.log('='.repeat(60));
    console.log(`Total recipes: ${recipes.length}`);
    console.log(`✅ Successfully processed: ${processed}`);
    console.log(`❌ Failed: ${failed}`);
    console.log(`Finished at: ${new Date().toISOString()}`);

    // Log failed recipes if any
    if (failedRecipes.length > 0) {
      console.log('\n⚠️  Failed recipes:');
      failedRecipes.forEach(({ id, title, error }) => {
        console.log(`  - ${title} (${id}): ${error}`);
      });
    }

    console.log('\n✅ Backfill complete!');
    process.exit(0);

  } catch (error) {
    console.error('\n❌ Backfill failed with error:', error);
    process.exit(1);
  }
}

// Run the backfill
backfillRecipeTags();
