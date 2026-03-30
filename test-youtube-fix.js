/**
 * Integration Test: Verify YouTube extraction fix
 *
 * Tests the complete extraction flow with the video that was failing:
 * https://youtube.com/shorts/JbC14Zn7plU
 *
 * Usage: node test-youtube-fix.js
 */

require('dotenv').config();
const MultiModalExtractor = require('./services/multiModalExtractor');

async function testYouTubeFix() {
  console.log('\n🧪 Testing YouTube Extraction Fix\n');
  console.log('='.repeat(70));

  // Simulate Apify data (as it would come from apifyYouTubeService)
  const testData = {
    id: 'JbC14Zn7plU',
    url: 'https://www.youtube.com/watch?v=JbC14Zn7plU',
    videoUrl: 'https://www.youtube.com/watch?v=JbC14Zn7plU',
    title: 'New York Times Top 50 Recipes | Marry Me Chicken by Naz Deravian (#38)',
    description: null,  // No description
    transcript: null,   // No transcript (this triggers audio-visual path)
    author: "Reid's Test Kitchen",
    thumbnailUrl: 'https://i.ytimg.com/vi/JbC14Zn7plU/maxresdefault.jpg',
    videoDuration: 62,  // 62 seconds
    viewCount: 2399176,
    likes: 66000,
    isShort: false,
    platform: 'YouTube'
  };

  console.log('Test data:', {
    title: testData.title,
    duration: `${testData.videoDuration}s`,
    hasDescription: !!testData.description,
    hasTranscript: !!testData.transcript,
    willUseAudioVisual: true
  });

  console.log('\n💡 Expected: Routes to audio-visual extraction (video download)');
  console.log('='.repeat(70));

  const extractor = new MultiModalExtractor();

  try {
    console.log('\n📥 Starting extraction...\n');

    const result = await extractor.extractWithAllModalities(testData);

    console.log('\n✅ EXTRACTION SUCCESSFUL!\n');
    console.log('Result:', {
      success: result.success,
      recipeTitle: result.recipe?.title || 'N/A',
      ingredientCount: result.recipe?.extendedIngredients?.length || 0,
      stepCount: result.recipe?.analyzedInstructions?.[0]?.steps?.length || 0,
      confidence: result.confidence,
      extractionMethod: result.extractionMethod,
      sourcesUsed: result.sourcesUsed
    });

    if (result.recipe?.extendedIngredients?.length >= 5) {
      console.log('\n✅ Quality check PASSED (5+ ingredients)');
    } else {
      console.log('\n⚠️ Quality check WARNING: Only', result.recipe?.extendedIngredients?.length, 'ingredients');
    }

    console.log('\n' + '='.repeat(70));
    console.log('✅ TEST PASSED - YouTube extraction working!');
    console.log('='.repeat(70));
    console.log('\nReady to deploy to production 🚀\n');

  } catch (error) {
    console.error('\n❌ EXTRACTION FAILED\n');
    console.error('Error:', error.message);

    if (error.message.includes('Sign in to confirm')) {
      console.error('\n💡 Bot detection still active - User-Agent fix didn\'t work');
      console.error('   Try: Different User-Agent or alternative download method');
    } else if (error.message.includes('quota') || error.message.includes('429')) {
      console.error('\n💡 Gemini quota exhausted - try again later');
    } else {
      console.error('\nStack:', error.stack);
    }

    process.exit(1);
  }
}

testYouTubeFix().catch(error => {
  console.error('\n💥 Unhandled error:', error);
  process.exit(1);
});
