// Quick debug script to test the recipe service directly
require('dotenv').config();
const recipeService = require('./services/recipeService');

async function testRecipeService() {
  console.log('🔍 Testing Recipe Service Debug');
  console.log('================================');
  
  console.log('Environment variables:');
  console.log('  SPOONACULAR_API_KEY:', process.env.SPOONACULAR_API_KEY ? 'Present' : 'Missing');
  console.log('  SUPABASE_URL:', process.env.SUPABASE_URL ? 'Present' : 'Missing');
  
  // Test with fake user ID and see what happens
  try {
    console.log('\n🧪 Testing with fake user ID...');
    const suggestions = await recipeService.getRecipeSuggestions('fake-user-id');
    console.log('✅ Got suggestions:', suggestions.length);
  } catch (error) {
    console.log('❌ Error:', error.message);
    console.log('   Error details:', error);
  }
  
  // Test API key directly
  try {
    console.log('\n🧪 Testing direct API call...');
    const recipes = await recipeService.searchRecipesByIngredients(['chicken', 'tomato']);
    console.log('✅ Got recipes:', recipes.length);
  } catch (error) {
    console.log('❌ Error:', error.message);
  }
}

testRecipeService().catch(console.error);