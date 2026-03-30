/**
 * Test Multiple Apify Video Downloader Actors
 * Finds which actor successfully downloads YouTube videos
 */

require('dotenv').config();
const axios = require('axios');

const APIFY_TOKEN = process.env.APIFY_API_TOKEN;
const TEST_URL = 'https://www.youtube.com/watch?v=wVHNa9EWDCU';

// Actors to test (from research)
const ACTORS = [
  {
    id: 'jy-labs/youtube-all-in-one-downloader-scraper',
    name: 'JY Labs All-in-One (InnerTube API)',
    input: { url: TEST_URL }
  },
  {
    id: 'xtech/youtube-video-downloader',
    name: 'XTech PRO (99.99% success)',
    input: { url: TEST_URL, quality: '720p' }
  },
  {
    id: 'streamers/youtube-video-downloader',
    name: 'Streamers (yt-dlp based)',
    input: { url: TEST_URL, format: 'mp4', quality: '720p' }
  },
  {
    id: 'epctex/youtube-video-downloader',
    name: 'Epctex (yt-dlp based)',
    input: { url: TEST_URL }
  },
  {
    id: 'scraper_one/yt-downloader',
    name: 'ScraperOne Downloader',
    input: { url: TEST_URL }
  }
];

async function testActor(actor) {
  console.log(`\n${'='.repeat(70)}`);
  console.log(`Testing: ${actor.name}`);
  console.log(`Actor ID: ${actor.id}`);
  console.log('='.repeat(70));

  try {
    // Start actor run
    console.log('Starting actor run...');
    const startResponse = await axios.post(
      `https://api.apify.com/v2/acts/${actor.id}/runs`,
      actor.input,
      {
        headers: { 'Authorization': `Bearer ${APIFY_TOKEN}` },
        timeout: 10000
      }
    );

    const runId = startResponse.data.data.id;
    console.log(`✅ Actor started! Run ID: ${runId}`);

    // Poll for completion (max 2 minutes)
    console.log('Waiting for completion...');
    for (let i = 0; i < 24; i++) {  // 24 * 5s = 120s
      await new Promise(resolve => setTimeout(resolve, 5000));

      const statusResponse = await axios.get(
        `https://api.apify.com/v2/actor-runs/${runId}`,
        { headers: { 'Authorization': `Bearer ${APIFY_TOKEN}` }}
      );

      const status = statusResponse.data.data.status;
      process.stdout.write(`\r  Status: ${status} (${i * 5}s)`);

      if (status === 'SUCCEEDED') {
        console.log('\n✅ Actor SUCCEEDED!');

        // Get results
        const datasetId = statusResponse.data.data.defaultDatasetId;
        const itemsResponse = await axios.get(
          `https://api.apify.com/v2/datasets/${datasetId}/items`,
          { headers: { 'Authorization': `Bearer ${APIFY_TOKEN}` }}
        );

        const result = itemsResponse.data[0];
        console.log('\nResult keys:', Object.keys(result || {}));

        // Check for video URL/file
        const videoKeys = ['videoUrl', 'downloadUrl', 'url', 'videoFile', 'mp4Url', 'fileUrl'];
        let foundVideo = false;

        for (const key of videoKeys) {
          if (result && result[key]) {
            console.log(`\n🎉 FOUND VIDEO: ${key} = ${result[key].substring(0, 80)}...`);
            foundVideo = true;
          }
        }

        if (foundVideo) {
          console.log(`\n✅✅✅ SUCCESS! Actor "${actor.name}" works!`);
          console.log(`\nRecommended actor ID: ${actor.id}`);
          return { success: true, actor };
        } else {
          console.log('\n⚠️ Actor succeeded but no video URL found');
          console.log('Result sample:', JSON.stringify(result).substring(0, 200));
        }

        return { success: false, reason: 'No video URL in output' };
      }

      if (status === 'FAILED' || status === 'ABORTED') {
        console.log(`\n❌ Actor ${status}`);
        return { success: false, reason: status };
      }
    }

    console.log('\n⏱️ Timeout (2 minutes)');
    return { success: false, reason: 'Timeout' };

  } catch (error) {
    if (error.response) {
      console.log(`\n❌ API Error: ${error.response.status} - ${error.response.statusText}`);
      if (error.response.status === 404) {
        console.log('  → Actor not found or incorrect ID format');
      } else if (error.response.status === 401) {
        console.log('  → Invalid API token');
      }
    } else {
      console.log(`\n❌ Error: ${error.message}`);
    }
    return { success: false, reason: error.message };
  }
}

async function main() {
  console.log('\n🧪 Testing Apify YouTube Video Downloader Actors\n');

  if (!APIFY_TOKEN) {
    console.error('❌ APIFY_API_TOKEN not set in environment');
    process.exit(1);
  }

  console.log(`Test video: ${TEST_URL}`);
  console.log(`Testing ${ACTORS.length} actors...\n`);

  for (const actor of ACTORS) {
    const result = await testActor(actor);

    if (result.success) {
      console.log('\n' + '='.repeat(70));
      console.log('🎉 SOLUTION FOUND!');
      console.log('='.repeat(70));
      console.log(`\nUse this actor: ${result.actor.id}`);
      console.log(`\nNext steps:`);
      console.log(`1. Update apifyVideoService.js with actor ID: "${result.actor.id}"`);
      console.log(`2. Update input format to match: ${JSON.stringify(result.actor.input)}`);
      console.log(`3. Deploy to production`);
      console.log(`4. Expect 99%+ success rate with zero maintenance\n`);
      return;
    }

    // Wait a bit between actors to avoid rate limiting
    await new Promise(resolve => setTimeout(resolve, 2000));
  }

  console.log('\n' + '='.repeat(70));
  console.log('❌ NO WORKING ACTOR FOUND');
  console.log('='.repeat(70));
  console.log('\nAlternatives:');
  console.log('1. Use cookie authentication with yt-dlp (manual refresh every 3-6 months)');
  console.log('2. Use residential proxy service ($10-15/month)');
  console.log('3. Accept 95% success rate (current behavior)\n');
}

main().catch(console.error);
