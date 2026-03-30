/**
 * Final Test: Recently Updated Apify Video Downloaders
 * Testing actors that were updated in March 2026
 */

require('dotenv').config();
const axios = require('axios');

const APIFY_TOKEN = process.env.APIFY_API_TOKEN;
const TEST_URL = 'https://www.youtube.com/watch?v=wVHNa9EWDCU';

// Recently updated actors (verified from Apify store March 2026)
const ACTORS = [
  {
    id: 'scraper_one/yt-downloader',  // Updated March 20, 2026
    name: 'ScraperOne (Updated 2 days ago!)',
    input: { url: TEST_URL }
  },
  {
    id: 'movo_ai/youtube-video-downloader',  // Updated Feb 10, 2026 - claims 100% success
    name: 'MovoAI (Claims 100% reliability)',
    input: { url: TEST_URL }
  },
  {
    id: 'fractalai/reliable-youtube-video-downloader',  // Updated Jan 18, 2026
    name: 'FractalAI (Uploads to cloud storage)',
    input: { url: TEST_URL }
  },
  {
    id: 'cheapget/best-video-downloader',  // Try this too
    name: 'Cheapget Best Downloader',
    input: { url: TEST_URL }
  }
];

async function quickTest(actor) {
  console.log(`\nTesting: ${actor.name} (${actor.id})`);

  try {
    const response = await axios.post(
      `https://api.apify.com/v2/acts/${actor.id}/runs`,
      actor.input,
      {
        headers: { 'Authorization': `Bearer ${APIFY_TOKEN}` },
        timeout: 5000
      }
    );

    console.log(`✅ Actor EXISTS and started! Run ID: ${response.data.data.id}`);
    return { exists: true, actor, runId: response.data.data.id };

  } catch (error) {
    if (error.response?.status === 404) {
      console.log(`❌ Actor NOT FOUND (404)`);
    } else if (error.response?.status === 402) {
      console.log(`⚠️ Payment required - actor exists but needs credits`);
      return { exists: true, needsPayment: true, actor };
    } else if (error.response?.status === 401) {
      console.log(`❌ Invalid API token`);
    } else {
      console.log(`❌ Error: ${error.response?.status || error.message}`);
    }
    return { exists: false };
  }
}

async function main() {
  console.log('\n🧪 Testing Recently Updated Apify Actors\n');
  console.log(`Test URL: ${TEST_URL}\n`);

  if (!APIFY_TOKEN) {
    console.error('❌ APIFY_API_TOKEN not set');
    process.exit(1);
  }

  const working = [];

  // Quick test all actors
  for (const actor of ACTORS) {
    const result = await quickTest(actor);
    if (result.exists) {
      working.push(result);
    }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  if (working.length === 0) {
    console.log('\n❌ NO ACTORS FOUND');
    console.log('\nThis suggests:');
    console.log('1. These actors might be private/deprecated');
    console.log('2. Actor IDs from web search might be incorrect');
    console.log('3. Apify might have changed their video download policy');
    console.log('\nRECOMMENDATION: Use cookie auth with yt-dlp instead (free, works)\n');
    process.exit(1);
  }

  console.log(`\n✅ Found ${working.length} working actor(s)!\n`);

  // Now wait for first one to complete
  const first = working[0];
  console.log(`Waiting for "${first.actor.name}" to complete...`);

  for (let i = 0; i < 30; i++) {
    await new Promise(resolve => setTimeout(resolve, 5000));

    try {
      const statusResp = await axios.get(
        `https://api.apify.com/v2/actor-runs/${first.runId}`,
        { headers: { 'Authorization': `Bearer ${APIFY_TOKEN}` }}
      );

      const status = statusResp.data.data.status;
      process.stdout.write(`\r  Status: ${status} (${i * 5}s)    `);

      if (status === 'SUCCEEDED') {
        const datasetId = statusResp.data.data.defaultDatasetId;
        const items = await axios.get(
          `https://api.apify.com/v2/datasets/${datasetId}/items`,
          { headers: { 'Authorization': `Bearer ${APIFY_TOKEN}` }}
        );

        console.log('\n\n✅ SUCCESS!');
        console.log('\nResult fields:', Object.keys(items.data[0] || {}));
        console.log('\nFull result sample:');
        console.log(JSON.stringify(items.data[0], null, 2).substring(0, 1000));

        console.log(`\n🎉 USE THIS ACTOR: ${first.actor.id}\n`);
        return;
      }

      if (status === 'FAILED') {
        console.log('\n❌ Actor failed');
        break;
      }
    } catch (e) {
      console.error(`\nError checking status: ${e.message}`);
      break;
    }
  }
}

main().catch(console.error);
