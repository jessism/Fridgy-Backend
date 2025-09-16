require('dotenv').config();
const ApifyInstagramService = require('./services/apifyInstagramService');

// Test Instagram image extraction
async function testImageExtraction() {
  console.log('🔍 Testing Instagram Image Extraction');
  console.log('=====================================\n');

  const apifyService = new ApifyInstagramService();

  // Test the reel URL that was mentioned in the error
  const testUrl = 'https://www.instagram.com/reel/Cygngu3Pgoq/?utm_source=ig_web_copy_link&igsh=MzRlODBiNWFlZA==';

  console.log('🎬 Testing URL:', testUrl);
  console.log('⏳ Extracting data...\n');

  try {
    // Test the extraction (this will use cached data if available)
    const result = await apifyService.extractFromUrl(testUrl, 'test-user');

    console.log('📊 Extraction Results:');
    console.log('Success:', result.success);
    console.log('Has Video:', !!result.videoUrl);
    console.log('Video Duration:', result.videoDuration);
    console.log('Has Caption:', !!result.caption);
    console.log('Caption Length:', result.caption?.length || 0);
    console.log('Image Count:', result.images?.length || 0);

    if (result.images && result.images.length > 0) {
      console.log('\n🖼️ Image Details:');
      result.images.forEach((img, index) => {
        console.log(`Image ${index + 1}:`, img.url);

        // Test if URL looks valid
        const isHttps = img.url.startsWith('https://');
        const hasInstagramDomain = img.url.includes('instagram') ||
                                   img.url.includes('fbcdn') ||
                                   img.url.includes('scontent');
        const hasImageExtension = /\.(jpg|jpeg|png|gif|webp)/i.test(img.url);

        console.log(`  - HTTPS: ${isHttps ? '✅' : '❌'}`);
        console.log(`  - Instagram Domain: ${hasInstagramDomain ? '✅' : '❌'}`);
        console.log(`  - Image Extension: ${hasImageExtension ? '✅' : '❌'}`);
      });
    } else {
      console.log('\n❌ No images found!');
      console.log('🔍 Checking what fields are available in raw data...');

      // This would show us what fields Apify actually returns
      if (result.extractedWithApify) {
        console.log('This was extracted with Apify - check the detailed logs above for field availability');
      }
    }

    // Test basic URL accessibility
    if (result.images && result.images.length > 0) {
      console.log('\n🌐 Testing URL Accessibility:');
      const testImageUrl = result.images[0].url;

      try {
        const axios = require('axios');
        const response = await axios.head(testImageUrl, {
          timeout: 5000,
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
          }
        });

        console.log('✅ Image URL is accessible');
        console.log('Status:', response.status);
        console.log('Content-Type:', response.headers['content-type']);
        console.log('Content-Length:', response.headers['content-length']);
      } catch (urlError) {
        console.log('❌ Image URL is NOT accessible');
        console.log('Error:', urlError.message);

        if (urlError.response) {
          console.log('Status:', urlError.response.status);
          console.log('Headers:', urlError.response.headers);
        }
      }
    }

  } catch (error) {
    console.error('💥 Extraction failed:', error.message);
  }
}

// Run the test
testImageExtraction().catch(console.error);