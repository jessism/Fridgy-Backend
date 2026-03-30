require('dotenv').config();
const { GoogleGenerativeAI } = require('@google/generative-ai');

// Initialize Gemini
console.log('API Key loaded:', process.env.GOOGLE_GEMINI_API_KEY ? `${process.env.GOOGLE_GEMINI_API_KEY.substring(0, 20)}...` : 'NOT FOUND');
const genAI = new GoogleGenerativeAI(process.env.GOOGLE_GEMINI_API_KEY);

async function testGeminiYouTubeURL() {
  console.log('\n🧪 TEST: Gemini API with YouTube URLs\n');
  console.log('='.repeat(50));

  const testVideos = [
    {
      name: 'Short recipe video (30 sec)',
      url: 'https://www.youtube.com/watch?v=4CCCxNfVXaY',
      expectedRecipe: 'Should find recipe details'
    },
    {
      name: 'YouTube Short (15 sec)',
      url: 'https://youtube.com/shorts/bFIxSh7YDT4',
      expectedRecipe: 'May have recipe on-screen'
    }
  ];

  // Test 1: Try direct YouTube URL as fileData
  console.log('\n📝 TEST 1: YouTube URL as fileData.fileUri\n');

  for (const video of testVideos) {
    console.log(`\nTesting: ${video.name}`);
    console.log(`URL: ${video.url}`);

    try {
      const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });

      const result = await model.generateContent({
        contents: [{
          role: 'user',
          parts: [
            {
              text: 'Analyze this cooking video and extract the recipe. List all ingredients and cooking steps you can see or hear.'
            },
            {
              fileData: {
                fileUri: video.url,
                mimeType: 'video/*'
              }
            }
          ]
        }]
      });

      const response = await result.response;
      const text = response.text();

      console.log('✅ SUCCESS - Gemini accepted YouTube URL!');
      console.log('Response preview:', text.substring(0, 200) + '...');
      console.log('Response length:', text.length, 'chars');

      return { success: true, method: 'fileData.fileUri', response: text };

    } catch (error) {
      console.log('❌ FAILED - fileData.fileUri method');
      console.log('Error:', error.message);
      console.log('Error code:', error.status);
      console.log('Error details:', JSON.stringify(error.response?.data || error, null, 2));
    }
  }

  // Test 2: Try YouTube URL in text prompt only
  console.log('\n📝 TEST 2: YouTube URL in text prompt (reference only)\n');

  try {
    const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash-exp' });

    const result = await model.generateContent({
      contents: [{
        role: 'user',
        parts: [{
          text: `Analyze this YouTube cooking video and extract the recipe: ${testVideos[0].url}

List all ingredients and cooking steps you can see or hear in the video.`
        }]
      }]
    });

    const response = await result.response;
    const text = response.text();

    console.log('✅ Response received');
    console.log('Response preview:', text.substring(0, 200) + '...');

    // Check if it actually analyzed the video or just gave generic response
    if (text.toLowerCase().includes('cannot access') ||
        text.toLowerCase().includes('cannot analyze') ||
        text.toLowerCase().includes('unable to')) {
      console.log('⚠️  Gemini cannot access YouTube URLs from text reference');
      return { success: false, method: 'text_reference', response: text };
    } else {
      console.log('✅ SUCCESS - Gemini analyzed from URL reference!');
      return { success: true, method: 'text_reference', response: text };
    }

  } catch (error) {
    console.log('❌ FAILED - Text reference method');
    console.log('Error:', error.message);
  }

  return { success: false, message: 'All methods failed - video downloading required' };
}

// Run tests
testGeminiYouTubeURL()
  .then(result => {
    console.log('\n' + '='.repeat(50));
    console.log('\n🎯 FINAL RESULT:\n');
    console.log(JSON.stringify(result, null, 2));
    console.log('\n' + '='.repeat(50));

    if (result.success) {
      console.log('\n✅ RECOMMENDATION: Use Gemini with YouTube URLs (no downloading needed)\n');
    } else {
      console.log('\n❌ RESULT: Gemini requires video upload (must download videos)\n');
      console.log('Options:');
      console.log('  1. Accept 70% coverage (FREE captions only)');
      console.log('  2. Download videos despite TOS violation');
      console.log('  3. Hybrid approach (captions + selective downloading)\n');
    }

    process.exit(0);
  })
  .catch(error => {
    console.error('\n❌ Test failed with error:', error);
    process.exit(1);
  });
