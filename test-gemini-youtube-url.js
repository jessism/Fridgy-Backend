/**
 * Test: Can Google Gemini analyze YouTube URLs directly?
 *
 * Since Google owns YouTube, Gemini might have special access
 * to analyze YouTube videos without downloading
 *
 * Usage: node test-gemini-youtube-url.js
 */

require('dotenv').config();
const { GoogleGenerativeAI } = require('@google/generative-ai');

async function testGeminiYouTubeURL() {
  console.log('\n🧪 Testing: Can Gemini analyze YouTube URLs directly?\n');
  console.log('=' .repeat(70));

  const apiKey = process.env.GOOGLE_GEMINI_API_KEY;
  if (!apiKey || apiKey === 'your_google_gemini_api_key_here') {
    console.error('❌ GOOGLE_GEMINI_API_KEY not configured');
    process.exit(1);
  }

  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });

  // Test with the video that's currently failing
  const testUrl = 'https://www.youtube.com/watch?v=JbC14Zn7plU';
  console.log('Test URL:', testUrl);
  console.log('Expected: "Marry Me Chicken" recipe video\n');

  // Try different formats
  const testCases = [
    {
      name: 'Format 1: Direct URL as text',
      content: `Extract the recipe from this YouTube video: ${testUrl}`
    },
    {
      name: 'Format 2: fileData with YouTube URL',
      content: [{
        fileData: {
          fileUri: testUrl,
          mimeType: 'video/mp4'
        }
      }, 'Extract the recipe from this video']
    },
    {
      name: 'Format 3: videoUrl field',
      content: [{
        videoUrl: testUrl
      }, 'Extract the recipe from this video']
    }
  ];

  for (const testCase of testCases) {
    console.log(`\n📝 Testing: ${testCase.name}`);
    console.log('-'.repeat(70));

    try {
      const result = await model.generateContent(testCase.content);
      const response = await result.response;
      const text = response.text();

      if (text && text.length > 50) {
        console.log('✅ SUCCESS! Gemini responded with:', text.substring(0, 200) + '...');
        console.log('\n🎉 Gemini CAN analyze YouTube URLs directly!');
        console.log('💡 This means we don\'t need yt-dlp or Apify for YouTube videos!\n');
        return;
      } else {
        console.log('⚠️ Got response but empty/short:', text);
      }

    } catch (error) {
      console.log(`❌ Failed: ${error.message}`);

      if (error.message.includes('PERMISSION_DENIED') || error.message.includes('403')) {
        console.log('   → Gemini API rejected (no permission for this format)');
      } else if (error.message.includes('INVALID_ARGUMENT')) {
        console.log('   → Invalid input format for Gemini API');
      } else if (error.message.includes('quota')) {
        console.log('   → Quota exhausted (try again later)');
      }
    }
  }

  console.log('\n' + '='.repeat(70));
  console.log('❌ CONCLUSION: Gemini cannot directly analyze YouTube URLs');
  console.log('💡 We need Apify or another download solution\n');
}

testGeminiYouTubeURL().catch(error => {
  console.error('\n💥 Unhandled error:', error.message);
  process.exit(1);
});
