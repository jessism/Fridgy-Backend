/**
 * Test Script: Verify Apify Video Downloader Actor
 *
 * Tests the streamers/youtube-video-downloader Apify actor
 * with the YouTube video that's currently failing with yt-dlp
 *
 * Usage: node test-apify-video.js
 */

require('dotenv').config();
const ApifyVideoService = require('./services/apifyVideoService');
const fs = require('fs').promises;

async function testApifyVideoDownload() {
  console.log('\n🧪 Testing Apify Video Download Service\n');
  console.log('=' .repeat(60));

  // Test with the video that's currently failing
  const testUrl = 'https://youtube.com/shorts/JbC14Zn7plU';
  console.log('Test URL:', testUrl);
  console.log('Expected: "Marry Me Chicken" recipe video (62 seconds)');
  console.log('=' .repeat(60));

  try {
    console.log('\n📥 Starting download...\n');

    const result = await ApifyVideoService.downloadVideo(testUrl);

    console.log('\n✅ SUCCESS! Video downloaded\n');
    console.log('Results:', {
      videoPath: result.videoPath,
      fileSize: `${(result.fileSize / 1024 / 1024).toFixed(2)} MB`,
      cost: `$${result.cost.toFixed(4)}`
    });

    // Verify file exists and has content
    const stats = await fs.stat(result.videoPath);
    console.log('\n📊 File verification:', {
      exists: true,
      size: `${(stats.size / 1024 / 1024).toFixed(2)} MB`,
      sizeBytes: stats.size
    });

    if (stats.size < 100000) {
      console.warn('\n⚠️ WARNING: File size suspiciously small (<100KB)');
    }

    // Clean up test file
    await fs.unlink(result.videoPath);
    console.log('\n🧹 Cleaned up test video file');

    console.log('\n' + '='.repeat(60));
    console.log('✅ TEST PASSED - Apify video download working!');
    console.log('='.repeat(60));
    console.log('\nNext steps:');
    console.log('1. Deploy updated code to Railway');
    console.log('2. Monitor first 10 extractions in production');
    console.log('3. Verify success rate improvement (94% → 99%+)');
    console.log('4. Track monthly costs (target: ~$6/month)');

  } catch (error) {
    console.error('\n❌ TEST FAILED\n');
    console.error('Error:', error.message);

    if (error.message.includes('APIFY_API_TOKEN')) {
      console.error('\n💡 Fix: Set APIFY_API_TOKEN environment variable');
    } else if (error.message.includes('401')) {
      console.error('\n💡 Fix: Check APIFY_API_TOKEN is valid');
    } else if (error.message.includes('timeout')) {
      console.error('\n💡 Fix: Apify actor might be slow, increase timeout or check actor status');
    } else if (error.message.includes('No video URL')) {
      console.error('\n💡 Fix: Actor might not support video downloads, check actor documentation');
    }

    console.error('\nStack:', error.stack);

    process.exit(1);
  }
}

// Run test
testApifyVideoDownload().catch(error => {
  console.error('\n💥 Unhandled error:', error);
  process.exit(1);
});
