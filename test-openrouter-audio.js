require('dotenv').config(); // Load environment variables from .env file

const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');

/**
 * Test script to verify OpenRouter Gemini 2.0 Flash audio API format
 *
 * CRITICAL: This must pass before implementing the full audio-visual extraction feature
 *
 * Requirements:
 * 1. Small test audio file (5-10 seconds, mp3 format)
 * 2. OPENROUTER_API_KEY environment variable set
 *
 * Expected result: Audio transcription in response.choices[0].message.content
 */

async function testOpenRouterAudio() {
  console.log('='.repeat(70));
  console.log('OpenRouter Gemini Audio API Test');
  console.log('='.repeat(70));

  // Check for API key
  if (!process.env.OPENROUTER_API_KEY) {
    console.error('❌ ERROR: OPENROUTER_API_KEY environment variable not set');
    process.exit(1);
  }

  // Check for test audio file
  const testAudioPath = path.join(__dirname, 'test-audio.mp3');
  if (!fs.existsSync(testAudioPath)) {
    console.error(`❌ ERROR: Test audio file not found at ${testAudioPath}`);
    console.log('\nPlease create a small test audio file (5-10 seconds) named test-audio.mp3');
    console.log('You can use any short audio clip with speech for testing.');
    process.exit(1);
  }

  try {
    // Read test audio file
    const audioBuffer = fs.readFileSync(testAudioPath);
    const audioBase64 = audioBuffer.toString('base64');
    const fileSizeKB = (audioBuffer.length / 1024).toFixed(2);

    console.log(`\n✓ Test audio file loaded: ${fileSizeKB} KB`);
    console.log(`✓ API key found: ${process.env.OPENROUTER_API_KEY.substring(0, 10)}...`);

    console.log('\n📡 Calling OpenRouter API...');
    console.log('Model: google/gemini-2.5-flash');
    console.log('Content type: input_audio with mp3 format\n');

    // Call OpenRouter API
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'google/gemini-2.5-flash',
        messages: [{
          role: 'user',
          content: [
            {
              type: 'input_audio',
              input_audio: {
                data: audioBase64,
                format: 'mp3'
              }
            },
            {
              type: 'text',
              text: 'Transcribe this audio exactly as spoken. Return only the transcript text with proper punctuation.'
            }
          ]
        }]
      })
    });

    console.log(`Status: ${response.status} ${response.statusText}`);

    const result = await response.json();

    if (!response.ok) {
      console.error('\n❌ API Request Failed');
      console.error('Response:', JSON.stringify(result, null, 2));

      if (result.error?.message) {
        console.error('\nError message:', result.error.message);
      }

      console.log('\n⚠️  Possible issues:');
      console.log('1. Model name incorrect or not available');
      console.log('2. API format changed - check OpenRouter docs');
      console.log('3. Audio format not supported (try different encoding)');
      console.log('4. API key invalid or quota exceeded');

      process.exit(1);
    }

    // Check for transcript in response
    const transcript = result.choices?.[0]?.message?.content;

    if (transcript) {
      console.log('\n' + '='.repeat(70));
      console.log('✅ SUCCESS! Audio transcription working');
      console.log('='.repeat(70));
      console.log('\nTranscript:');
      console.log('-'.repeat(70));
      console.log(transcript);
      console.log('-'.repeat(70));
      console.log(`\nTranscript length: ${transcript.length} characters`);

      // Check usage/cost info if available
      if (result.usage) {
        console.log('\nAPI Usage:');
        console.log(JSON.stringify(result.usage, null, 2));
      }

      console.log('\n✅ OpenRouter Gemini audio API format verified!');
      console.log('✅ You can proceed with implementing audioProcessor.js');
      console.log('\n' + '='.repeat(70));

    } else {
      console.log('\n❌ FAILED - No transcript in response');
      console.log('\nFull response:');
      console.log(JSON.stringify(result, null, 2));
      console.log('\n⚠️  The API format may have changed.');
      console.log('⚠️  Check OpenRouter documentation for correct audio input format.');
      console.log('⚠️  DO NOT PROCEED with implementation until this is fixed.');
      process.exit(1);
    }

  } catch (error) {
    console.error('\n❌ Test failed with error:');
    console.error(error.message);
    if (error.stack) {
      console.error('\nStack trace:');
      console.error(error.stack);
    }
    process.exit(1);
  }
}

// Run test
testOpenRouterAudio().catch(error => {
  console.error('\n❌ Unexpected error:', error);
  process.exit(1);
});
