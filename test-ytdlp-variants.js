/**
 * Test: Try different yt-dlp configurations to evade YouTube bot detection
 *
 * Tests various flags and techniques to make yt-dlp look more like a real browser
 *
 * Usage: node test-ytdlp-variants.js
 */

const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);
const fs = require('fs').promises;
const path = require('path');
const os = require('os');

async function testYtDlpVariants() {
  console.log('\n🧪 Testing yt-dlp Bot Evasion Techniques\n');
  console.log('='.repeat(70));

  const testUrl = 'https://www.youtube.com/watch?v=JbC14Zn7plU';
  const testVideo = path.join(os.tmpdir(), `test_${Date.now()}.mp4`);

  const variants = [
    {
      name: 'Variant 1: User-Agent spoofing',
      command: `yt-dlp --user-agent "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36" -f "best[ext=mp4]" -o "${testVideo}" "${testUrl}"`
    },
    {
      name: 'Variant 2: Add browser headers',
      command: `yt-dlp --add-header "Accept-Language:en-US,en;q=0.9" --add-header "Accept:text/html,application/xhtml+xml" -f "best[ext=mp4]" -o "${testVideo}" "${testUrl}"`
    },
    {
      name: 'Variant 3: Slower rate limiting',
      command: `yt-dlp --sleep-interval 3 --max-sleep-interval 8 -f "best[ext=mp4]" -o "${testVideo}" "${testUrl}"`
    },
    {
      name: 'Variant 4: Different format selection',
      command: `yt-dlp -f "worst[ext=mp4]" -o "${testVideo}" "${testUrl}"`
    },
    {
      name: 'Variant 5: Use youtube-dl (original tool)',
      command: `youtube-dl -f "best[ext=mp4]" -o "${testVideo}" "${testUrl}"`
    }
  ];

  for (const variant of variants) {
    console.log(`\n📝 ${variant.name}`);
    console.log('-'.repeat(70));
    console.log('Command:', variant.command.substring(0, 100) + '...');

    try {
      const { stdout, stderr } = await execPromise(variant.command, {
        timeout: 30000,
        maxBuffer: 10 * 1024 * 1024
      });

      // Check if file was created
      try {
        const stats = await fs.stat(testVideo);
        console.log(`✅ SUCCESS! Downloaded ${(stats.size / 1024 / 1024).toFixed(2)} MB`);
        console.log(`\n🎉 SOLUTION FOUND: ${variant.name} works!\n`);

        // Clean up
        await fs.unlink(testVideo);

        console.log('=' .repeat(70));
        console.log('Next step: Update multiModalExtractor.js with this command');
        return;

      } catch (e) {
        console.log('⚠️ Command completed but no file created');
      }

    } catch (error) {
      const errorMsg = error.stderr || error.message || String(error);

      if (errorMsg.includes('not a bot')) {
        console.log('❌ Still blocked by bot detection');
      } else if (errorMsg.includes('404') || errorMsg.includes('Not Found')) {
        console.log('❌ Tool not found (yt-dlp or youtube-dl not installed)');
      } else if (errorMsg.includes('400')) {
        console.log('❌ Bad Request (bot detection)');
      } else {
        console.log(`❌ Failed: ${errorMsg.substring(0, 100)}`);
      }
    }
  }

  console.log('\n' + '='.repeat(70));
  console.log('❌ CONCLUSION: All yt-dlp variants blocked by YouTube');
  console.log('💡 Need alternative solution (Apify, proxies, or graceful degradation)\n');
}

testYtDlpVariants().catch(error => {
  console.error('\n💥 Error:', error.message);
});
