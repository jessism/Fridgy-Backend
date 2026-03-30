/**
 * Test script to verify YouTube transcript extraction fix
 * Tests the failing video: h6VO3aXOHd8 ("Wife me up" Chili Garlic Noodles)
 */

require('dotenv').config();
const ApifyYouTubeService = require('./services/apifyYouTubeService');

async function testYouTubeExtraction() {
  console.log('='.repeat(60));
  console.log('Testing YouTube Transcript Extraction Fix');
  console.log('='.repeat(60));
  console.log('');

  const youtubeService = new ApifyYouTubeService();
  const testUrl = 'https://www.youtube.com/watch?v=h6VO3aXOHd8';

  console.log('Test URL:', testUrl);
  console.log('Video: "Wife me up" Chili Garlic Noodles (46 seconds)');
  console.log('');
  console.log('This video was previously failing with:');
  console.log('  InnertubeError: CompositeVideoPrimaryInfo not found!');
  console.log('');
  console.log('Expected with fix:');
  console.log('  - Transcript extracted successfully OR');
  console.log('  - Graceful fallback with clear error message');
  console.log('');
  console.log('-'.repeat(60));
  console.log('Starting extraction...');
  console.log('-'.repeat(60));
  console.log('');

  try {
    const result = await youtubeService.extractVideoData(testUrl);

    console.log('');
    console.log('='.repeat(60));
    console.log('✅ EXTRACTION SUCCESSFUL!');
    console.log('='.repeat(60));
    console.log('');
    console.log('Result Summary:');
    console.log('  - Title:', result.title);
    console.log('  - Duration:', result.videoDuration, 'seconds');
    console.log('  - Is Short:', result.isShort);
    console.log('  - Description length:', result.description?.length || 0, 'chars');
    console.log('  - Transcript available:', !!result.transcript);
    if (result.transcript) {
      console.log('  - Transcript length:', result.transcript.length, 'chars');
      console.log('  - Transcript preview:', result.transcript.substring(0, 100) + '...');
    }
    console.log('  - Caption length:', result.caption?.length || 0, 'chars');
    console.log('');

    if (result.caption?.length > 100) {
      console.log('✅ Caption/Description available - will use text-based extraction (FREE)');
    } else {
      console.log('⚠️  Limited text - may need audio-visual fallback ($0.0006)');
    }

    console.log('');
    console.log('Full result:');
    console.log(JSON.stringify(result, null, 2));

    return result;

  } catch (error) {
    console.log('');
    console.log('='.repeat(60));
    console.log('❌ EXTRACTION FAILED');
    console.log('='.repeat(60));
    console.log('');
    console.log('Error:', error.message);
    console.log('');
    console.log('Stack trace:');
    console.log(error.stack);
    console.log('');
    console.log('If you see InnertubeError, the fix did not work.');
    console.log('If you see graceful error messages, the fix is working but transcript unavailable.');

    throw error;
  }
}

// Run test
testYouTubeExtraction()
  .then(() => {
    console.log('');
    console.log('='.repeat(60));
    console.log('Test completed successfully!');
    console.log('='.repeat(60));
    process.exit(0);
  })
  .catch((error) => {
    console.log('');
    console.log('='.repeat(60));
    console.log('Test failed with error');
    console.log('='.repeat(60));
    process.exit(1);
  });
