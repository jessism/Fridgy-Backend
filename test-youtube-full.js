#!/usr/bin/env node
/**
 * Complete YouTube Recipe Extraction Test
 * Tests the full extraction flow including audio-visual fallback
 */

require('dotenv').config();
const fetch = require('node-fetch');

// You'll need a valid auth token for this test
const AUTH_TOKEN = process.env.TEST_AUTH_TOKEN || 'YOUR_TOKEN_HERE';
const API_URL = process.env.API_URL || 'http://localhost:5000';

async function testYouTubeExtraction() {
  console.log('\n' + '='.repeat(70));
  console.log('🧪 TESTING YOUTUBE RECIPE EXTRACTION');
  console.log('='.repeat(70) + '\n');

  // Test video that was failing
  const testUrl = 'https://www.youtube.com/watch?v=h6VO3aXOHd8';

  console.log('📹 Test Video:', testUrl);
  console.log('   Title: "Wife me up" Chili Garlic Noodles');
  console.log('   Duration: 46 seconds');
  console.log('   Previously failing with: CompositeVideoPrimaryInfo error\n');

  console.log('🔄 Making API request to:', `${API_URL}/api/youtube-recipes/multi-modal-extract\n`);

  const startTime = Date.now();

  try {
    const response = await fetch(`${API_URL}/api/youtube-recipes/multi-modal-extract`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${AUTH_TOKEN}`
      },
      body: JSON.stringify({
        url: testUrl
      })
    });

    const duration = ((Date.now() - startTime) / 1000).toFixed(2);

    console.log('📊 Response Status:', response.status, response.statusText);
    console.log('⏱️  Processing Time:', duration, 'seconds\n');

    const result = await response.json();

    if (response.ok) {
      console.log('='.repeat(70));
      console.log('✅ SUCCESS! Recipe Extracted');
      console.log('='.repeat(70) + '\n');

      console.log('📝 Recipe Details:');
      console.log('   Title:', result.recipe?.title || 'N/A');
      console.log('   Servings:', result.recipe?.servings || 'N/A');
      console.log('   Ready in:', result.recipe?.readyInMinutes || 'N/A', 'minutes');
      console.log('   Ingredients:', result.recipe?.extendedIngredients?.length || 0);
      console.log('   Steps:', result.recipe?.analyzedInstructions?.[0]?.steps?.length || 0);
      console.log('   Confidence:', (result.confidence || 0).toFixed(2));
      console.log('   Extraction Method:', result.extractionMethod || 'N/A');

      console.log('\n🧪 Test Analysis:');
      if (result.extractionMethod?.includes('audio-visual')) {
        console.log('   ✅ Audio-visual fallback worked!');
        console.log('   💰 Cost: ~$0.0006 (expected when no transcript)');
      } else if (result.extractionMethod?.includes('text')) {
        console.log('   ✅ Text-based extraction worked!');
        console.log('   💰 Cost: $0 (free)');
      }

      console.log('\n📋 Ingredients:');
      result.recipe?.extendedIngredients?.slice(0, 5).forEach((ing, i) => {
        console.log(`   ${i + 1}. ${ing.original || ing.name}`);
      });
      if (result.recipe?.extendedIngredients?.length > 5) {
        console.log(`   ... and ${result.recipe.extendedIngredients.length - 5} more`);
      }

      console.log('\n📖 Steps:');
      result.recipe?.analyzedInstructions?.[0]?.steps?.slice(0, 3).forEach((step) => {
        console.log(`   ${step.number}. ${step.step.substring(0, 80)}${step.step.length > 80 ? '...' : ''}`);
      });
      if (result.recipe?.analyzedInstructions?.[0]?.steps?.length > 3) {
        console.log(`   ... and ${result.recipe.analyzedInstructions[0].steps.length - 3} more steps`);
      }

      console.log('\n' + '='.repeat(70));
      console.log('✅ ALL TESTS PASSED!');
      console.log('='.repeat(70));

      return true;

    } else {
      console.log('='.repeat(70));
      console.log('❌ API Error');
      console.log('='.repeat(70) + '\n');
      console.log('Error:', result.error || result.message || 'Unknown error');
      console.log('\nFull response:');
      console.log(JSON.stringify(result, null, 2));

      return false;
    }

  } catch (error) {
    console.log('='.repeat(70));
    console.log('❌ REQUEST FAILED');
    console.log('='.repeat(70) + '\n');
    console.log('Error:', error.message);
    console.log('\nStack trace:');
    console.log(error.stack);

    return false;
  }
}

async function testWithoutAuth() {
  console.log('\n' + '='.repeat(70));
  console.log('🔓 TESTING WITHOUT AUTH (Should see limit info)');
  console.log('='.repeat(70) + '\n');

  const testUrl = 'https://www.youtube.com/watch?v=h6VO3aXOHd8';

  try {
    const response = await fetch(`${API_URL}/api/youtube-recipes/multi-modal-extract`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        url: testUrl
      })
    });

    const result = await response.json();

    console.log('Status:', response.status);
    console.log('Response:', JSON.stringify(result, null, 2));

    if (response.status === 401 || response.status === 403) {
      console.log('\n✅ Auth protection working correctly');
    }

  } catch (error) {
    console.log('Error:', error.message);
  }
}

// Main execution
async function main() {
  console.log('\n🎯 YouTube Extraction Fix - Integration Test');
  console.log('   Backend URL:', API_URL);
  console.log('   Auth Token:', AUTH_TOKEN === 'YOUR_TOKEN_HERE' ? '❌ NOT SET' : '✅ Set');
  console.log('');

  if (AUTH_TOKEN === 'YOUR_TOKEN_HERE') {
    console.log('⚠️  WARNING: No auth token set!');
    console.log('   Set TEST_AUTH_TOKEN in .env or update the script\n');
    console.log('   Testing without auth first...\n');

    await testWithoutAuth();

    console.log('\n📝 To test with auth:');
    console.log('   1. Get a token from your app (sign in and copy JWT)');
    console.log('   2. Add to .env: TEST_AUTH_TOKEN=your_token');
    console.log('   3. Or run: TEST_AUTH_TOKEN=your_token node test-youtube-full.js\n');

    process.exit(0);
  }

  const success = await testYouTubeExtraction();
  process.exit(success ? 0 : 1);
}

main();
