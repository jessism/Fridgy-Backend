const https = require('https');

// Test script for Spoonacular API
// Run this script after adding SPOONACULAR_API_KEY to your .env file
// Usage: node test-spoonacular-api.js

require('dotenv').config();

const SPOONACULAR_API_KEY = process.env.SPOONACULAR_API_KEY;
const BASE_URL = 'api.spoonacular.com';

if (!SPOONACULAR_API_KEY) {
  console.error('❌ SPOONACULAR_API_KEY not found in .env file');
  console.log('Please add SPOONACULAR_API_KEY=your-key-here to your .env file');
  console.log('Get your free API key at: https://spoonacular.com/food-api/console');
  process.exit(1);
}

// Helper function to make HTTPS requests
function makeRequest(path) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: BASE_URL,
      path: path,
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      
      res.on('data', (chunk) => {
        data += chunk;
      });
      
      res.on('end', () => {
        try {
          const jsonData = JSON.parse(data);
          resolve(jsonData);
        } catch (error) {
          reject(new Error(`Failed to parse JSON: ${error.message}`));
        }
      });
    });

    req.on('error', (error) => {
      reject(error);
    });

    req.end();
  });
}

// Test 1: Search recipes by ingredients
async function testRecipesByIngredients() {
  console.log('\n🧪 Testing: findByIngredients endpoint');
  console.log('=====================================');
  
  try {
    // Test with common fridge ingredients
    const ingredients = ['chicken,tomatoes,onions'];
    const path = `/recipes/findByIngredients?ingredients=${ingredients}&number=5&apiKey=${SPOONACULAR_API_KEY}`;
    
    console.log(`🔗 Request: GET ${BASE_URL}${path.replace(SPOONACULAR_API_KEY, 'API_KEY')}`);
    
    const recipes = await makeRequest(path);
    
    console.log(`✅ Found ${recipes.length} recipes`);
    console.log('\n📋 Sample Recipe:');
    if (recipes.length > 0) {
      const recipe = recipes[0];
      console.log(`   ID: ${recipe.id}`);
      console.log(`   Title: ${recipe.title}`);
      console.log(`   Image: ${recipe.image}`);
      console.log(`   Used Ingredients: ${recipe.usedIngredientCount}`);
      console.log(`   Missing Ingredients: ${recipe.missedIngredientCount}`);
      console.log(`   Unused Ingredients: ${recipe.unusedIngredients?.length || 0}`);
      
      if (recipe.usedIngredients) {
        console.log('\n   🥘 Used Ingredients:');
        recipe.usedIngredients.forEach(ing => {
          console.log(`      - ${ing.name} (${ing.amount} ${ing.unit})`);
        });
      }
      
      if (recipe.missedIngredients) {
        console.log('\n   ❓ Missing Ingredients:');
        recipe.missedIngredients.forEach(ing => {
          console.log(`      - ${ing.name} (${ing.amount} ${ing.unit})`);
        });
      }
      
      return recipe.id; // Return first recipe ID for detailed test
    }
  } catch (error) {
    console.error(`❌ Error: ${error.message}`);
  }
  
  return null;
}

// Test 2: Get detailed recipe information
async function testRecipeDetails(recipeId) {
  console.log('\n🧪 Testing: Recipe Information endpoint');
  console.log('======================================');
  
  if (!recipeId) {
    console.log('⏭️  Skipping (no recipe ID from previous test)');
    return;
  }
  
  try {
    const path = `/recipes/${recipeId}/information?includeNutrition=false&apiKey=${SPOONACULAR_API_KEY}`;
    
    console.log(`🔗 Request: GET ${BASE_URL}${path.replace(SPOONACULAR_API_KEY, 'API_KEY')}`);
    
    const recipe = await makeRequest(path);
    
    console.log('✅ Recipe details retrieved');
    console.log('\n📋 Recipe Information:');
    console.log(`   Title: ${recipe.title}`);
    console.log(`   Ready in: ${recipe.readyInMinutes} minutes`);
    console.log(`   Servings: ${recipe.servings}`);
    console.log(`   Source: ${recipe.sourceName || 'N/A'}`);
    console.log(`   Health Score: ${recipe.healthScore || 'N/A'}`);
    console.log(`   Price per serving: $${recipe.pricePerServing ? (recipe.pricePerServing / 100).toFixed(2) : 'N/A'}`);
    
    if (recipe.extendedIngredients) {
      console.log('\n   🥘 All Ingredients:');
      recipe.extendedIngredients.slice(0, 5).forEach(ing => {
        console.log(`      - ${ing.original}`);
      });
      if (recipe.extendedIngredients.length > 5) {
        console.log(`      ... and ${recipe.extendedIngredients.length - 5} more`);
      }
    }
    
    if (recipe.instructions) {
      console.log('\n   📝 Instructions: Available');
    }
    
    console.log(`\n   🖼️  Image: ${recipe.image}`);
    
  } catch (error) {
    console.error(`❌ Error: ${error.message}`);
  }
}

// Test 3: Parse ingredients
async function testIngredientParsing() {
  console.log('\n🧪 Testing: Ingredient Parsing endpoint');
  console.log('======================================');
  
  try {
    const testIngredients = ['2 cups flour', '1 large egg', '500g chicken breast'];
    
    for (const ingredient of testIngredients) {
      const path = `/food/ingredients/parse?ingredientList=${encodeURIComponent(ingredient)}&apiKey=${SPOONACULAR_API_KEY}`;
      
      console.log(`🔗 Parsing: "${ingredient}"`);
      
      const parsed = await makeRequest(path);
      
      if (parsed.length > 0) {
        const ing = parsed[0];
        console.log(`   ✅ Name: ${ing.name}, Amount: ${ing.amount}, Unit: ${ing.unit}`);
      }
    }
  } catch (error) {
    console.error(`❌ Error: ${error.message}`);
  }
}

// Run all tests
async function runAllTests() {
  console.log('🚀 Starting Spoonacular API Tests');
  console.log('==================================');
  console.log(`🔑 API Key: ${SPOONACULAR_API_KEY.substring(0, 10)}...`);
  
  const recipeId = await testRecipesByIngredients();
  await testRecipeDetails(recipeId);
  await testIngredientParsing();
  
  console.log('\n✨ Testing complete!');
  console.log('\n💡 Next steps:');
  console.log('   1. Review the data structure above');
  console.log('   2. Check that image URLs work');
  console.log('   3. Confirm the API key is working correctly');
  console.log('   4. Consider which endpoints you need for your app');
}

// Run the tests
runAllTests().catch(error => {
  console.error('💥 Test failed:', error.message);
  process.exit(1);
});