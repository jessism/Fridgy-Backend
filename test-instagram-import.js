require('dotenv').config();
const InstagramExtractor = require('./services/instagramExtractor');
const RecipeAIExtractor = require('./services/recipeAIExtractor');

async function testInstagramImport() {
  console.log('\n========== TESTING INSTAGRAM IMPORT ==========\n');

  const instagramExtractor = new InstagramExtractor();
  const recipeAI = new RecipeAIExtractor();

  // Test URL - you can replace this with any Instagram recipe post
  const testUrl = 'https://www.instagram.com/p/DKqd_RmtSXJ/';

  console.log('Testing with URL:', testUrl);
  console.log('API Key configured:', !!process.env.RAPIDAPI_KEY);
  console.log('OpenRouter Key configured:', !!process.env.OPENROUTER_API_KEY);
  console.log('\n--- Step 1: Extract Instagram Content ---');

  try {
    // Extract Instagram content
    const instagramData = await instagramExtractor.extractFromUrl(testUrl);

    console.log('\nExtraction result:');
    console.log('- Success:', instagramData.success);
    console.log('- Has Caption:', !!instagramData.caption);
    console.log('- Caption Length:', instagramData.caption?.length || 0);
    console.log('- Caption Preview:', instagramData.caption?.substring(0, 100) || 'No caption');
    console.log('- Images Count:', instagramData.images?.length || 0);
    console.log('- Author:', instagramData.author?.username || 'unknown');
    console.log('- Requires Manual Caption:', instagramData.requiresManualCaption || false);

    if (!instagramData.success && instagramData.requiresManualCaption) {
      console.log('\n⚠️  Instagram extraction failed - would require manual caption input');
      return;
    }

    console.log('\n--- Step 2: Extract Recipe with AI ---');

    // Extract recipe using AI
    const aiResult = await recipeAI.extractFromInstagramData(instagramData);

    console.log('\nAI extraction result:');
    console.log('- Success:', aiResult.success);
    console.log('- Confidence:', aiResult.confidence);
    console.log('- Recipe Title:', aiResult.recipe?.title || 'No title');
    console.log('- Ingredients Count:', aiResult.recipe?.extendedIngredients?.length || 0);
    console.log('- Instructions Steps:', aiResult.recipe?.analyzedInstructions?.[0]?.steps?.length || 0);
    console.log('- Ready In Minutes:', aiResult.recipe?.readyInMinutes || 'Not specified');

    if (aiResult.recipe?.extendedIngredients?.length > 0) {
      console.log('\nFirst 3 ingredients:');
      aiResult.recipe.extendedIngredients.slice(0, 3).forEach(ing => {
        console.log(`  - ${ing.amount} ${ing.unit} ${ing.name}`);
      });
    }

    if (aiResult.confidence < 0.3) {
      console.log('\n⚠️  Low confidence extraction - would need manual completion');
    } else {
      console.log('\n✅ Recipe successfully extracted and ready to save!');
    }

  } catch (error) {
    console.error('\n❌ Error during testing:', error.message);
    console.error('Stack trace:', error.stack);
  }

  console.log('\n========== TEST COMPLETE ==========\n');
}

// Run the test
testInstagramImport();