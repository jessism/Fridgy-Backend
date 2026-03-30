/**
 * Test with a video known to have transcripts
 */

require('dotenv').config();

async function testTranscript() {
  try {
    console.log('Testing transcript extraction with a video that has transcripts...');
    console.log('');

    const apifyYouTubeService = require('./services/apifyYouTubeService');

    // Test with a popular cooking video that likely has captions
    const videoId = 'fk9yZSSiynY'; // Korean chicken bowls (from the original plan)
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
      console.log('⚠️  No transcript returned');
      console.log('(This is OK - the error was handled gracefully)');
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
