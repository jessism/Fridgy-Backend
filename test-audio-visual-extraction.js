require('dotenv').config();
const youtubeService = require('./services/apifyYouTubeService');
const MultiModalExtractor = require('./services/multiModalExtractor');

console.log('🧪 Testing Audio-Visual YouTube Extraction');
console.log('='.repeat(70));
console.log('\n📋 Test Configuration:');
console.log('  Video: YouTube Short fk9yZSSiynY (Korean chicken bowls, 29 seconds)');
console.log('  Expected: No description/transcript, requires audio-visual extraction');
console.log('  Target: 5+ ingredients, 3+ steps, confidence 0.70-0.90');
console.log('\n' + '='.repeat(70) + '\n');

async function testAudioVisualExtraction() {
  const testUrl = 'https://youtube.com/shorts/fk9yZSSiynY';

  console.log('🎬 Step 1: Fetching video metadata with Apify...\n');

  const extractor = new MultiModalExtractor();

  try {
    // Fetch video metadata
    const startTime = Date.now();
    const apifyData = await youtubeService.extractFromUrl(testUrl, 'test-user-id');
    const fetchTime = Date.now() - startTime;

    console.log('✅ Apify data fetched in', fetchTime, 'ms');
    console.log('\n🔍 RAW APIFY DATA STRUCTURE:');
    console.log('All keys:', Object.keys(apifyData));
    console.log('Full data:', JSON.stringify(apifyData, null, 2).substring(0, 1000));
    console.log('\n📊 Video Metadata:');
    console.log('  Success:', apifyData.success);
    console.log('  Duration:', apifyData.videoDuration || 'N/A', 'seconds');
    console.log('  Caption length:', apifyData.caption?.length || 0, 'chars');
    console.log('  Transcript length:', apifyData.transcript?.length || 0, 'chars');
    console.log('  Video URL:', apifyData.videoUrl || 'N/A');
    console.log('  Is Short:', apifyData.isShort || false);
    console.log('  Images:', apifyData.images?.length || 0);
    console.log('  Author:', apifyData.author?.username || 'N/A');
    console.log('\n' + '-'.repeat(70) + '\n');

    // Check if this will trigger audio-visual extraction
    const willUseAudioVisual = !apifyData.caption && !apifyData.transcript;
    console.log('🔍 Extraction Path Analysis:');
    console.log('  Has caption:', !!apifyData.caption, `(${apifyData.caption?.length || 0} chars)`);
    console.log('  Has transcript:', !!apifyData.transcript, `(${apifyData.transcript?.length || 0} chars)`);
    console.log('  Has videoUrl:', !!apifyData.videoUrl);
    console.log('  Will use audio-visual:', willUseAudioVisual ? '✅ YES' : '❌ NO');
    console.log('\n' + '-'.repeat(70) + '\n');

    if (!willUseAudioVisual) {
      console.log('⚠️  WARNING: This video has text content available!');
      console.log('   Audio-visual extraction may not be triggered.');
      console.log('   Proceeding anyway to test the full extraction flow...\n');
    }

    // Perform extraction
    console.log('🎯 Step 2: Starting recipe extraction...\n');
    const extractionStart = Date.now();

    const result = await extractor.extractWithAllModalities(apifyData);

    const extractionTime = Date.now() - extractionStart;
    const totalTime = Date.now() - startTime;

    console.log('\n' + '='.repeat(70));
    console.log('\n📊 EXTRACTION RESULTS\n');
    console.log('='.repeat(70) + '\n');

    console.log('⏱️  Performance:');
    console.log('  Apify fetch time:', fetchTime, 'ms');
    console.log('  Extraction time:', extractionTime, 'ms');
    console.log('  Total time:', totalTime, 'ms');
    console.log('  Target: < 20000 ms');
    console.log('  Status:', totalTime < 20000 ? '✅ PASS' : '❌ FAIL');
    console.log('');

    console.log('🎯 Extraction Status:');
    console.log('  Success:', result.success ? '✅ YES' : '❌ NO');
    console.log('  Confidence:', result.confidence || 'N/A');
    console.log('  Method:', result.extractionMethod || 'N/A');
    console.log('');

    if (result.sourcesUsed) {
      console.log('📚 Sources Used:');
      console.log('  Audio:', result.sourcesUsed.audio ? '✅ YES' : '❌ NO');
      console.log('  Video keyframes:', result.sourcesUsed.videoKeyframes || 0);
      console.log('  Caption:', result.sourcesUsed.caption ? '✅ YES' : '❌ NO');
      console.log('  Images:', result.sourcesUsed.images || 0);
      if (result.sourcesUsed.audioTranscript) {
        console.log('  Transcript preview:', result.sourcesUsed.audioTranscript.substring(0, 100) + '...');
      }
      console.log('');
    }

    if (result.recipe) {
      const ingredientCount = result.recipe.extendedIngredients?.length || 0;
      const stepCount = result.recipe.analyzedInstructions?.[0]?.steps?.length || 0;

      console.log('📝 Recipe Details:');
      console.log('  Title:', result.recipe.title || 'N/A');
      console.log('  Ingredients:', ingredientCount);
      console.log('  Steps:', stepCount);
      console.log('  Ready in:', result.recipe.readyInMinutes || 'N/A', 'minutes');
      console.log('  Servings:', result.recipe.servings || 'N/A');
      console.log('');

      console.log('🔍 Quality Check:');
      console.log('  Ingredients >= 5:', ingredientCount >= 5 ? '✅ PASS' : `❌ FAIL (${ingredientCount})`);
      console.log('  Steps >= 3:', stepCount >= 3 ? '✅ PASS' : `❌ FAIL (${stepCount})`);
      console.log('  Confidence 0.70-0.90:', (result.confidence >= 0.70 && result.confidence <= 0.90) ? '✅ PASS' : `❌ FAIL (${result.confidence})`);
      console.log('');

      if (ingredientCount > 0) {
        console.log('🥗 Sample Ingredients (first 3):');
        result.recipe.extendedIngredients.slice(0, 3).forEach((ing, idx) => {
          console.log(`  ${idx + 1}. ${ing.original || ing.name || 'Unknown'}`);
        });
        console.log('');
      }

      if (stepCount > 0) {
        console.log('👨‍🍳 Sample Steps (first 2):');
        result.recipe.analyzedInstructions[0].steps.slice(0, 2).forEach((step) => {
          console.log(`  ${step.number}. ${step.step}`);
        });
        console.log('');
      }
    }

    console.log('='.repeat(70));
    console.log('\n✅ TEST COMPLETE\n');

    // Overall success assessment
    const ingredientCount = result.recipe?.extendedIngredients?.length || 0;
    const stepCount = result.recipe?.analyzedInstructions?.[0]?.steps?.length || 0;
    const allChecksPassed = (
      result.success &&
      ingredientCount >= 5 &&
      stepCount >= 3 &&
      result.confidence >= 0.70 &&
      result.confidence <= 0.90 &&
      totalTime < 20000
    );

    if (allChecksPassed) {
      console.log('🎉 ALL CHECKS PASSED - Audio-visual extraction working correctly!\n');
    } else {
      console.log('⚠️  SOME CHECKS FAILED - Review results above\n');
    }

    console.log('📋 Next Steps:');
    console.log('  1. Check server logs for detailed extraction flow');
    console.log('  2. Verify temp files were cleaned up: ls -la /tmp/audio_* /tmp/frames_* /tmp/video_*');
    console.log('  3. Test cache hit by running the same video again');
    console.log('  4. Check OpenRouter costs in the logs\n');

    return result;

  } catch (error) {
    console.error('\n❌ TEST FAILED WITH ERROR:\n');
    console.error('Error:', error.message);
    console.error('Stack:', error.stack);

    console.log('\n🔍 Troubleshooting:');
    console.log('  1. Check OPENROUTER_API_KEY is set correctly');
    console.log('  2. Verify FFmpeg is installed: which ffmpeg');
    console.log('  3. Check server logs for detailed error messages');
    console.log('  4. Ensure video downloads successfully\n');

    throw error;
  }
}

// Run the test
testAudioVisualExtraction()
  .then(() => {
    console.log('Test script completed successfully');
    process.exit(0);
  })
  .catch((error) => {
    console.error('Test script failed:', error.message);
    process.exit(1);
  });
