/**
 * Test script for YouTube video download waterfall implementation
 * Tests the new multi-provider fallback strategy
 */

require('dotenv').config();

// Test video URLs
const testUrls = [
  {
    url: 'https://youtube.com/shorts/hKdWeq4LXFw',
    description: 'The failing short from logs',
  },
  {
    url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    description: 'Regular YouTube video',
  },
];

async function testWaterfall() {
  console.log('🧪 Testing YouTube Video Download Waterfall\n');
  console.log('=' .repeat(60));

  // Check environment variables
  console.log('\n📋 Environment Check:');
  console.log('  APIFY_API_TOKEN:', process.env.APIFY_API_TOKEN ? '✅ Set' : '❌ Missing');
  console.log('  BRIGHTDATA_AUTH:', process.env.BRIGHTDATA_AUTH ? '✅ Set' : '❌ Missing');
  console.log('  SCRAPER_API_KEY:', process.env.SCRAPER_API_KEY ? '✅ Set' : '❌ Missing');

  const MultiModalExtractor = require('./services/multiModalExtractor');
  const extractor = new MultiModalExtractor();

  for (const test of testUrls) {
    console.log('\n' + '='.repeat(60));
    console.log(`\n🎯 Testing: ${test.description}`);
    console.log(`   URL: ${test.url}\n`);

    try {
      const videoPath = await extractor.downloadVideoToTemp(test.url);
      console.log('\n✅ SUCCESS!');
      console.log(`   Downloaded to: ${videoPath}`);

      // Clean up test file
      const fs = require('fs').promises;
      try {
        await fs.unlink(videoPath);
        console.log('   ✓ Test file cleaned up');
      } catch (e) {
        console.warn('   ⚠️ Could not clean up test file:', e.message);
      }

    } catch (error) {
      console.error('\n❌ FAILED!');
      console.error(`   Error: ${error.message}`);
    }
  }

  console.log('\n' + '='.repeat(60));
  console.log('\n📊 Provider Success Stats:', extractor.providerStats);
  console.log('\n🧪 Test complete!\n');
}

// Run the test
testWaterfall().catch(error => {
  console.error('\n💥 Test crashed:', error);
  process.exit(1);
});
