require('dotenv').config();
const RecipeAIExtractor = require('./services/recipeAIExtractor');

async function testAIExtraction() {
  console.log('\n========== TESTING AI EXTRACTION WITH MOCK DATA ==========\n');

  const recipeAI = new RecipeAIExtractor();

  // Mock Instagram data with a recipe caption
  const mockInstagramData = {
    success: true,
    caption: `🍝 Creamy Garlic Parmesan Pasta

INGREDIENTS:
• 1 lb fettuccine pasta
• 4 cloves garlic, minced
• 1 cup heavy cream
• 1 cup freshly grated Parmesan cheese
• 2 tbsp butter
• 2 tbsp olive oil
• Salt and pepper to taste
• Fresh parsley for garnish

INSTRUCTIONS:
1. Cook pasta according to package directions until al dente. Reserve 1 cup pasta water before draining.
2. In a large skillet, melt butter with olive oil over medium heat.
3. Add minced garlic and sauté for 1 minute until fragrant.
4. Pour in heavy cream and bring to a gentle simmer.
5. Add Parmesan cheese and stir until melted and smooth.
6. Add cooked pasta to the sauce and toss to combine.
7. Add pasta water as needed to reach desired consistency.
8. Season with salt and pepper.
9. Garnish with fresh parsley and extra Parmesan.

Ready in 20 minutes! Perfect for weeknight dinners 🌟

#pasta #italianfood #easyrecipes #dinnerideas #comfortfood #homecooking`,
    images: [{
      url: 'https://images.unsplash.com/photo-1546069901-ba9599a7e63c',
      width: 1080,
      height: 1080
    }],
    author: {
      username: 'testfoodblogger'
    },
    hashtags: ['pasta', 'italianfood', 'easyrecipes']
  };

  console.log('Testing AI extraction with:');
  console.log('- Caption Length:', mockInstagramData.caption.length);
  console.log('- Has Images:', mockInstagramData.images.length > 0);
  console.log('- OpenRouter Key configured:', !!process.env.OPENROUTER_API_KEY);
  console.log('- Model:', recipeAI.model);

  try {
    console.log('\n--- Extracting Recipe with AI ---');

    // Extract recipe using AI
    const aiResult = await recipeAI.extractFromInstagramData(mockInstagramData);

    console.log('\nAI extraction result:');
    console.log('- Success:', aiResult.success);
    console.log('- Confidence:', aiResult.confidence);
    console.log('- Recipe Title:', aiResult.recipe?.title || 'No title');
    console.log('- Summary:', aiResult.recipe?.summary?.substring(0, 100) || 'No summary');
    console.log('- Ingredients Count:', aiResult.recipe?.extendedIngredients?.length || 0);
    console.log('- Instructions Steps:', aiResult.recipe?.analyzedInstructions?.[0]?.steps?.length || 0);
    console.log('- Ready In Minutes:', aiResult.recipe?.readyInMinutes || 'Not specified');
    console.log('- Servings:', aiResult.recipe?.servings || 'Not specified');

    if (aiResult.recipe?.extendedIngredients?.length > 0) {
      console.log('\nFirst 3 ingredients:');
      aiResult.recipe.extendedIngredients.slice(0, 3).forEach(ing => {
        console.log(`  - ${ing.amount} ${ing.unit} ${ing.name}`);
      });
    }

    if (aiResult.recipe?.analyzedInstructions?.[0]?.steps?.length > 0) {
      console.log('\nFirst 3 instruction steps:');
      aiResult.recipe.analyzedInstructions[0].steps.slice(0, 3).forEach(step => {
        console.log(`  ${step.number}. ${step.step.substring(0, 80)}...`);
      });
    }

    if (aiResult.confidence < 0.3) {
      console.log('\n⚠️  Low confidence extraction - would need manual completion');
    } else {
      console.log('\n✅ Recipe successfully extracted with high confidence!');
    }

  } catch (error) {
    console.error('\n❌ Error during AI extraction:', error.message);
    if (error.message.includes('404')) {
      console.error('Note: Model might not be available. Current model:', recipeAI.model);
    }
  }

  console.log('\n========== TEST COMPLETE ==========\n');
}

// Run the test
testAIExtraction();