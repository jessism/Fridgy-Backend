/**
 * Generate Demo Recipes Script
 *
 * This script calls the AI recipe generation service once to create
 * 3 high-quality recipes using the 5 demo inventory items.
 *
 * Usage: node scripts/generateDemoRecipes.js
 */

const fs = require('fs');
const path = require('path');

// Import AI recipe service (exported as singleton)
const aiRecipeService = require('../services/aiRecipeService');

// Demo inventory items (same as used in frontend)
const DEMO_INVENTORY = [
  {
    item_name: 'Chicken Breast',
    quantity: 1,
    category: 'Protein',
    expiration_date: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
    total_weight_oz: 16,
    uploaded_at: new Date().toISOString(),
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    isDemo: true
  },
  {
    item_name: 'Broccoli',
    quantity: 1,
    category: 'Vegetables',
    expiration_date: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
    total_weight_oz: 8,
    uploaded_at: new Date().toISOString(),
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    isDemo: true
  },
  {
    item_name: 'Eggs',
    quantity: 3,
    category: 'Protein',
    expiration_date: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
    total_weight_oz: 12,
    uploaded_at: new Date().toISOString(),
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    isDemo: true
  },
  {
    item_name: 'Asparagus',
    quantity: 1,
    category: 'Vegetables',
    expiration_date: new Date(Date.now() + 4 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
    total_weight_oz: 6,
    uploaded_at: new Date().toISOString(),
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    isDemo: true
  },
  {
    item_name: 'Spaghetti',
    quantity: 1,
    category: 'Grains',
    expiration_date: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
    total_weight_oz: 16,
    uploaded_at: new Date().toISOString(),
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    isDemo: true
  }
];

// Generic questionnaire preferences (no restrictions)
const QUESTIONNAIRE_DATA = {
  dietaryPreferences: [], // No restrictions
  cuisinePreferences: [], // Any cuisine
  skillLevel: 'intermediate',
  prepTimeMax: 45,
  servings: 2
};

async function generateDemoRecipes() {
  console.log('🤖 Starting demo recipe generation...');
  console.log('📦 Using 5 demo inventory items:');
  DEMO_INVENTORY.forEach(item => {
    console.log(`   - ${item.item_name} (${item.total_weight_oz}oz, ${item.category})`);
  });
  console.log('');

  try {
    // Generate recipes using the AI service (direct generation, no caching)
    console.log('🔄 Calling AI recipe service directly (bypassing cache)...');

    // Format preferences from questionnaire data
    const preferences = {
      dietary_restrictions: QUESTIONNAIRE_DATA.dietaryPreferences || [],
      preferred_cuisines: QUESTIONNAIRE_DATA.cuisinePreferences || [],
      cooking_time_preference: QUESTIONNAIRE_DATA.prepTimeMax ? `${QUESTIONNAIRE_DATA.prepTimeMax} minutes` : ''
    };

    // Call generateRecipes directly (no caching, no user ID needed)
    // Returns array of recipes directly
    const recipes = await aiRecipeService.generateRecipes(
      DEMO_INVENTORY,
      preferences,
      QUESTIONNAIRE_DATA
    );

    if (!recipes || !Array.isArray(recipes) || recipes.length === 0) {
      throw new Error('AI recipe generation failed or returned no recipes');
    }

    console.log(`✅ Generated ${recipes.length} recipes successfully!`);
    console.log('');

    // Take top 3 recipes
    const top3Recipes = recipes.slice(0, 3);

    // Format for frontend
    const formattedOutput = {
      recipes: top3Recipes.map(recipe => ({
        ...recipe,
        isDemo: true
      })),
      meta: {
        generatedFor: 'Demo inventory: Chicken Breast, Broccoli, Eggs, Asparagus, Spaghetti',
        generatedAt: new Date().toISOString().split('T')[0],
        version: '1.0',
        description: 'Pre-generated recipes for welcome tour demonstration. These recipes are shown to all new users during onboarding.',
        generatedBy: 'generateDemoRecipes.js script',
        aiModel: 'gemini-2.0-flash'
      }
    };

    // Save to file
    const outputPath = path.join(__dirname, 'demo-recipes-output.json');
    fs.writeFileSync(outputPath, JSON.stringify(formattedOutput, null, 2), 'utf8');

    console.log('💾 Recipes saved to:', outputPath);
    console.log('');
    console.log('📋 Generated Recipes:');
    top3Recipes.forEach((recipe, index) => {
      console.log(`   ${index + 1}. ${recipe.title}`);
      console.log(`      - Image: ${recipe.image ? '✅' : '❌'}`);
      console.log(`      - Servings: ${recipe.servings}`);
      console.log(`      - Ready in: ${recipe.readyInMinutes} min`);
      console.log(`      - Ingredients: ${recipe.extendedIngredients?.length || 0}`);
      console.log('');
    });

    console.log('✅ Demo recipe generation complete!');
    console.log('');
    console.log('📝 Next steps:');
    console.log('   1. Review the generated recipes in demo-recipes-output.json');
    console.log('   2. Copy the content to Frontend/src/data/demoRecipes.json');
    console.log('   3. Re-enable demo mode in useAIRecipes.js');
    console.log('');

  } catch (error) {
    console.error('');
    console.error('❌ Error generating demo recipes:', error);
    console.error('');
    console.error('Error details:', error.message);
    console.error('');

    if (error.stack) {
      console.error('Stack trace:');
      console.error(error.stack);
    }

    process.exit(1);
  }
}

// Run the script
console.log('');
console.log('═══════════════════════════════════════════════════════════');
console.log('  Demo Recipe Generator for Fridgy Welcome Tour');
console.log('═══════════════════════════════════════════════════════════');
console.log('');

generateDemoRecipes()
  .then(() => {
    console.log('✨ Script completed successfully!');
    process.exit(0);
  })
  .catch((error) => {
    console.error('💥 Script failed:', error.message);
    process.exit(1);
  });
