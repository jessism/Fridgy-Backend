# How to Verify YouTube Download Fix is Working

## Quick Check (2 minutes)

### Option 1: Check Railway Logs (EASIEST)

1. Go to Railway dashboard → Your project → Deployments
2. Click on latest deployment (should have redeployed when you added SCRAPER_API_KEY)
3. Look for these log messages:

**✅ SUCCESS indicators**:
```
[MultiModal] Downloading with ScraperAPI residential proxy (bypasses bot detection)
[MultiModal] ✓ YouTube video downloaded successfully: XX.XX MB
[AudioProcessor] ✓ Audio extraction complete
[VideoProcessor] ✓ Successfully extracted 8/8 frames
[MultiModal] ✓ Recipe extraction successful
```

**❌ FAILURE indicators (old behavior)**:
```
[MultiModal] Downloading with direct connection (may fail on production)
ERROR: [youtube] wVHNa9EWDCU: Sign in to confirm you're not a bot
```

---

### Option 2: Test with Mobile App (RECOMMENDED)

1. Open your Trackabite mobile app
2. Try importing a YouTube Short that previously failed:
   - `https://youtube.com/shorts/wVHNa9EWDCU` (Hot Honey Baked Feta & Salmon Pasta)
   - `https://youtube.com/shorts/JbC14Zn7plU` (Marry Me Chicken)

3. Watch for:
   - ✅ Recipe extracted successfully
   - ✅ 5+ ingredients shown
   - ✅ Cooking steps included
   - ✅ No "extraction failed" error

---

### Option 3: Check Deployment Status

```bash
# Check if Railway has the environment variable
# (Run this in your terminal)
curl https://your-backend-url.railway.app/api/health
```

Look for deployment timestamp to verify it redeployed after you added the key.

---

## What to Look For

### ✅ Fix is WORKING:
- Railway logs show "ScraperAPI residential proxy"
- No more "Sign in to confirm you're not a bot" errors
- Videos download successfully (logs show file sizes in MB)
- Recipe extractions succeed with 5+ ingredients
- Success rate improves to 95%+

### ❌ Fix NOT working yet:
- Logs still show "direct connection (may fail)"
- Still seeing bot detection errors
- Videos still failing to extract

**If NOT working**:
1. Check Railway actually redeployed (deployment timestamp)
2. Verify SCRAPER_API_KEY variable is saved (Railway → Variables)
3. Check for typos in the key
4. Verify ScraperAPI account is active (not suspended/quota exceeded)

---

## Test Cases to Try

Once deployed, test these scenarios:

### Test 1: Video WITHOUT Transcript (Previously Failed)
```
URL: https://youtube.com/shorts/wVHNa9EWDCU
Expected: ✅ Extraction succeeds
Expected ingredients: 5+ (feta, salmon, pasta, honey, etc.)
```

### Test 2: Video WITH Transcript (Should Still Work)
```
URL: Any YouTube video with auto-captions
Expected: ✅ Uses FREE transcript path (doesn't hit ScraperAPI)
```

### Test 3: Check ScraperAPI Usage
```
1. Visit https://www.scraperapi.com/dashboard
2. Check "API Calls" counter
3. Should increase by 1 for each video download
4. Verify cost is tracking correctly
```

---

## Expected Timeline

1. **Immediately**: Railway starts redeploying (1-3 minutes)
2. **After redeploy**: New code active with proxy support
3. **First test**: Next YouTube video import will use proxy
4. **Check logs**: Within 5 minutes you'll see proxy logs

---

## Monitoring for Next 24 Hours

**What to watch**:
- YouTube extraction success rate (should jump to 99%+)
- ScraperAPI usage dashboard (should see ~2-5 calls/day)
- Railway logs for any proxy errors
- User complaints about failed extractions (should drop to near zero)

**Alert me if**:
- Still seeing "Sign in to confirm you're not a bot" errors after 1 hour
- ScraperAPI usage unexpectedly high (>100 calls/day)
- Success rate doesn't improve

---

## Quick Checklist

- [x] Added SCRAPER_API_KEY to Railway ✅ (You just did this!)
- [ ] Verified Railway redeployed (check deployment timestamp)
- [ ] Checked logs for "ScraperAPI residential proxy" message
- [ ] Tested with previously failing video URL
- [ ] Confirmed extraction now succeeds
- [ ] Checked ScraperAPI dashboard shows usage

**Next**: Wait 2-3 minutes for Railway redeploy, then check logs!
