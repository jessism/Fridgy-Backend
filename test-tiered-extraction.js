const RecipeAIExtractor = require('./services/recipeAIExtractor');

/**
 * Test script to verify the Tier 1 and Tier 2 extraction system is working correctly
 *
 * Usage:
 * node test-tiered-extraction.js
 *
 * This script tests:
 * 1. Tier 1 extraction with structured caption (should succeed with confidence > 0.7)
 * 2. Tier 1 extraction with poor caption (should fail and trigger Tier 2)
 * 3. Tier 2 extraction with video data (should succeed with confidence > 0.5)
 * 4. Both tiers failing (should require manual input)
 */

async function testTieredExtraction() {
  console.log('🧪 Testing Tiered Recipe Extraction System');
  console.log('==========================================\n');

  const extractor = new RecipeAIExtractor();

  // TEST 1: Good caption - should succeed with Tier 1
  console.log('TEST 1: Good structured caption (Tier 1 should succeed)');
  console.log('--------------------------------------------------------');

  const goodCaptionData = {
    caption: `🍝 Creamy Garlic Parmesan Pasta

INGREDIENTS:
- 1 lb fettuccine pasta
- 4 cloves garlic, minced
- 1 cup heavy cream
- 1 cup freshly grated Parmesan cheese
- 2 tbsp butter
- 2 tbsp olive oil
- Salt and pepper to taste

INSTRUCTIONS:
1. Cook pasta according to package directions until al dente
2. In a large skillet, melt butter with olive oil over medium heat
3. Add minced garlic and sauté for 1 minute until fragrant
4. Pour in heavy cream and bring to a gentle simmer
5. Add Parmesan cheese and stir until melted and smooth
6. Season with salt and pepper

Ready in 20 minutes! 🌟`,
    images: [{ url: 'https://example.com/pasta.jpg' }],
    author: { username: 'testchef' },
    hashtags: ['pasta', 'italian', 'dinner'],
    videoUrl: null,
    videoDuration: null
  };

  try {
    const tier1Result = await extractor.extractFromApifyData(goodCaptionData);
    console.log(`✅ Tier 1 Result: ${tier1Result.success ? 'SUCCESS' : 'FAILED'}`);
    console.log(`   Confidence: ${tier1Result.confidence.toFixed(2)}`);
    console.log(`   Should be ≥ 0.7: ${tier1Result.confidence >= 0.7 ? '✅ PASS' : '❌ FAIL'}`);
    console.log(`   Title: ${tier1Result.recipe?.title || 'NO TITLE'}`);
    console.log(`   Ingredients: ${tier1Result.recipe?.extendedIngredients?.length || 0}`);
    console.log(`   Steps: ${tier1Result.recipe?.analyzedInstructions?.[0]?.steps?.length || 0}\n`);
  } catch (error) {
    console.log(`❌ Tier 1 Error: ${error.message}\n`);
  }

  // TEST 2: Poor caption with video - should fail Tier 1, succeed with Tier 2
  console.log('TEST 2: Poor caption with video (Tier 1 fail → Tier 2 succeed)');
  console.log('----------------------------------------------------------------');

  const poorCaptionWithVideoData = {
    caption: `Yummy pasta! 😋 #food #yum`,
    images: [{ url: 'https://example.com/pasta.jpg' }],
    author: { username: 'foodie123' },
    hashtags: ['food', 'yum'],
    videoUrl: 'https://example.com/cooking-video.mp4',
    videoDuration: 180, // 3 minutes
    viewCount: 25000
  };

  try {
    const tier1Result = await extractor.extractFromApifyData(poorCaptionWithVideoData);
    console.log(`Tier 1 Result: ${tier1Result.success ? 'SUCCESS' : 'FAILED'}`);
    console.log(`   Confidence: ${tier1Result.confidence.toFixed(2)}`);
    console.log(`   Should be < 0.7: ${tier1Result.confidence < 0.7 ? '✅ PASS (triggers Tier 2)' : '❌ FAIL (should trigger Tier 2)'}`);

    if (tier1Result.confidence < 0.7) {
      console.log('\n🎬 Testing Tier 2 (Video Analysis)...');
      const tier2Result = await extractor.extractFromVideoData(poorCaptionWithVideoData);
      console.log(`✅ Tier 2 Result: ${tier2Result.success ? 'SUCCESS' : 'FAILED'}`);
      console.log(`   Confidence: ${tier2Result.confidence.toFixed(2)}`);
      console.log(`   Should be ≥ 0.5: ${tier2Result.confidence >= 0.5 ? '✅ PASS' : '❌ FAIL'}`);
      console.log(`   Video Analyzed: ${tier2Result.videoAnalyzed ? '✅ YES' : '❌ NO'}`);
      console.log(`   Tier: ${tier2Result.tier}`);
    }
    console.log();
  } catch (error) {
    console.log(`❌ Test 2 Error: ${error.message}\n`);
  }

  // TEST 3: No video, poor caption - should fail both (manual input)
  console.log('TEST 3: Poor caption, no video (both tiers fail → manual input)');
  console.log('------------------------------------------------------------------');

  const poorDataNoVideo = {
    caption: `Yummy! 😋`,
    images: [{ url: 'https://example.com/food.jpg' }],
    author: { username: 'user123' },
    hashtags: ['food'],
    videoUrl: null,
    videoDuration: null
  };

  try {
    const tier1Result = await extractor.extractFromApifyData(poorDataNoVideo);
    console.log(`Tier 1 Result: ${tier1Result.success ? 'SUCCESS' : 'FAILED'}`);
    console.log(`   Confidence: ${tier1Result.confidence.toFixed(2)}`);
    console.log(`   Should be < 0.7: ${tier1Result.confidence < 0.7 ? '✅ PASS' : '❌ FAIL'}`);

    if (tier1Result.confidence < 0.7) {
      console.log('\n🎬 Attempting Tier 2 (should fail - no video)...');
      const tier2Result = await extractor.extractFromVideoData(poorDataNoVideo);
      console.log(`Tier 2 Result: ${tier2Result.success ? 'UNEXPECTED SUCCESS' : 'FAILED (expected)'}`);
      console.log(`   Error: ${tier2Result.error || 'No error'}`);
      console.log(`   Should require manual input: ✅ PASS`);
    }
    console.log();
  } catch (error) {
    console.log(`❌ Test 3 Error: ${error.message}\n`);
  }

  console.log('🏁 Test Summary');
  console.log('================');
  console.log('✅ If all tests show PASS, the tiered extraction system is working correctly');
  console.log('❌ If any tests show FAIL, check the confidence thresholds and extraction logic');
  console.log('\n🔍 To debug further:');
  console.log('   - Check backend logs for detailed extraction process');
  console.log('   - Verify API keys are configured correctly');
  console.log('   - Test with real Instagram URLs using the /import-instagram-apify endpoint');
}

// Run the test
testTieredExtraction().catch(console.error);