/**
 * Simple test for transcript extraction
 */

require('dotenv').config();

async function testTranscript() {
  try {
    console.log('Testing transcript extraction...');
    console.log('');

    const apifyYouTubeService = require('./services/apifyYouTubeService');

    const videoId = 'h6VO3aXOHd8';
    console.log('Video ID:', videoId);
    console.log('');

    const transcript = await apifyYouTubeService.extractTranscript(videoId);

    console.log('');
    console.log('Result:');
    if (transcript) {
      console.log('✅ Transcript extracted successfully!');
      console.log('Length:', transcript.length, 'chars');
      console.log('Preview:', transcript.substring(0, 200));
    } else {
      console.log('⚠️  No transcript returned (this is OK - should have graceful error logs above)');
    }

  } catch (error) {
    console.error('');
    console.error('❌ Error caught:');
    console.error('Message:', error.message);
    console.error('');
    console.error('Stack:');
    console.error(error.stack);
  }
}

testTranscript();
