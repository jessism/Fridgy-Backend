/**
 * Test ScraperAPI Residential Proxy with yt-dlp
 * Verifies that ScraperAPI can bypass YouTube's bot detection
 *
 * Prerequisites:
 * 1. Sign up at https://www.scraperapi.com (free 5,000 calls)
 * 2. Get API key from dashboard
 * 3. Set environment variable: export SCRAPER_API_KEY=your_key
 *
 * Usage: SCRAPER_API_KEY=your_key node test-scraperapi-proxy.js
 */

require('dotenv').config();
const { exec } = require('child_process');
const util = require('util');
const fs = require('fs');
const execPromise = util.promisify(exec);

async function testScraperAPIProxy() {
  console.log('\n🧪 Testing ScraperAPI Residential Proxy with yt-dlp\n');
  console.log('='.repeat(70));

  const apiKey = process.env.SCRAPER_API_KEY;

  if (!apiKey) {
    console.error('❌ SCRAPER_API_KEY not set in environment');
    console.error('\nTo fix:');
    console.error('1. Sign up at https://www.scraperapi.com/signup');
    console.error('2. Get your API key from the dashboard');
    console.error('3. Run: export SCRAPER_API_KEY=your_key_here');
    console.error('4. Then run this test again\n');
    process.exit(1);
  }

  const proxyUrl = `http://scraperapi:${apiKey}@proxy-server.scraperapi.com:8001`;
  const testVideo = '/tmp/test_scraperapi_video.mp4';
  const testUrl = 'https://www.youtube.com/watch?v=wVHNa9EWDCU'; // Failing video from production

  console.log('Test video:', testUrl);
  console.log('Expected: "Hot Honey Baked Feta & Salmon Pasta" (32 seconds)');
  console.log('Proxy:', proxyUrl.substring(0, 40) + '...');
  console.log('='.repeat(70));

  try {
    console.log('\n📥 Downloading via ScraperAPI residential proxy...\n');

    const userAgent = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
    const command = `yt-dlp --proxy "${proxyUrl}" --user-agent "${userAgent}" -f "best[ext=mp4]" -o "${testVideo}" "${testUrl}"`;

    console.log('Command: yt-dlp --proxy "..." --user-agent "..." -f "best[ext=mp4]" ...\n');

    const startTime = Date.now();

    const { stdout, stderr } = await execPromise(command, {
      timeout: 120000  // 2 minute timeout (proxies are slower)
    });

    const downloadTime = ((Date.now() - startTime) / 1000).toFixed(1);

    console.log('✅ DOWNLOAD SUCCESSFUL!\n');
    console.log('Download time:', downloadTime, 'seconds');

    if (stdout) {
      console.log('\nyt-dlp output:', stdout.substring(0, 300));
    }

    // Check file size
    const stats = fs.statSync(testVideo);
    const sizeMB = (stats.size / 1024 / 1024).toFixed(2);

    console.log('\n📊 File verification:');
    console.log('  Size:', sizeMB, 'MB');
    console.log('  Path:', testVideo);

    if (stats.size < 100000) {
      console.warn('\n⚠️ WARNING: File size suspiciously small (<100KB)');
      console.warn('Download may have failed despite no errors');
    } else {
      console.log('  ✅ File size looks good');
    }

    // Cleanup
    fs.unlinkSync(testVideo);
    console.log('\n🧹 Cleaned up test file');

    console.log('\n' + '='.repeat(70));
    console.log('✅ TEST PASSED - ScraperAPI proxy works with yt-dlp!');
    console.log('='.repeat(70));
    console.log('\n📋 Next steps:');
    console.log('1. Add SCRAPER_API_KEY to Railway environment variables');
    console.log('2. Deploy updated multiModalExtractor.js (already committed)');
    console.log('3. Monitor Railway logs for successful downloads');
    console.log('4. Verify 99%+ success rate');
    console.log('5. Check ScraperAPI usage dashboard\n');

    return true;

  } catch (error) {
    console.error('\n❌ TEST FAILED\n');
    console.error('Error:', error.message);

    if (error.message.includes('Sign in to confirm')) {
      console.error('\n💡 Bot detection still active even with proxy');
      console.error('   Possible issues:');
      console.error('   - ScraperAPI key might be invalid');
      console.error('   - ScraperAPI quota exhausted');
      console.error('   - Proxy server might be down');
      console.error('   - Try different proxy service (BrightData, Smartproxy)');
    } else if (error.message.includes('timeout')) {
      console.error('\n💡 Download timed out (proxies are slower)');
      console.error('   This is normal - will work in production with proper timeout');
    } else if (error.message.includes('407')) {
      console.error('\n💡 Proxy authentication failed');
      console.error('   Check SCRAPER_API_KEY is correct');
    } else if (error.stderr) {
      console.error('\nyt-dlp stderr:', error.stderr.substring(0, 500));
    }

    console.error('\n' + '='.repeat(70));
    console.error('❌ ScraperAPI proxy test failed');
    console.error('='.repeat(70));
    console.error('\nAlternatives:');
    console.error('1. Try BrightData ($10/month) instead of ScraperAPI');
    console.error('2. Use cookie authentication (free but needs manual refresh)');
    console.error('3. Accept 95% success rate (current system)\n');

    return false;
  }
}

testScraperAPIProxy().then(success => {
  process.exit(success ? 0 : 1);
}).catch(error => {
  console.error('\n💥 Unhandled error:', error);
  process.exit(1);
});
