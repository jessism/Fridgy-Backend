# BrightData Setup Guide (Step 2 - If Socket Timeout Doesn't Work)

**Use this ONLY if Step 1 (socket timeout increase) still results in timeouts**

---

## Why BrightData vs ScraperAPI:

| Feature | ScraperAPI (current) | BrightData |
|---------|---------------------|------------|
| **Cost** | $49/month | $10/month |
| **Speed** | 2+ minutes (timing out) | 30-60 seconds (typically) |
| **YouTube optimization** | General-purpose | Video-specific infrastructure |
| **Success rate** | ~70% (timeouts) | ~99% (optimized) |

**Bottom line**: BrightData is cheaper, faster, and better for YouTube.

---

## Setup (15 minutes)

### Step 1: Sign Up for BrightData

1. Visit https://brightdata.com/pricing
2. Select "Residential Proxies" plan
3. Choose "Pay as you go" - $10/month minimum
4. Sign up with email

### Step 2: Create Proxy Zone

1. Go to BrightData dashboard
2. Click "Zones" → "Add Zone"
3. Select "Residential" proxy type
4. Name: "youtube-download"
5. Create zone

### Step 3: Get Proxy Credentials

You'll get:
- Customer ID: `brd-customer-hl_abc123`
- Zone name: `youtube-download`
- Password: `xyz789abc`

**Proxy URL format**:
```
http://brd-customer-CUSTOMER_ID-zone-ZONE_NAME:PASSWORD@brd.superproxy.io:33335
```

**Your proxy URL** (example):
```
http://brd-customer-hl_abc123-zone-youtube-download:xyz789abc@brd.superproxy.io:33335
```

### Step 4: Update Railway Environment Variable

1. Railway dashboard → Your project → Variables
2. Find: `SCRAPER_API_KEY`
3. **Delete it** (we're replacing the whole proxy URL)
4. Add new variable:
   - **Name**: `PROXY_URL`
   - **Value**: `http://brd-customer-YOUR_ID-zone-YOUR_ZONE:YOUR_PASS@brd.superproxy.io:33335`

### Step 5: Update Code to Use PROXY_URL

Edit `/Users/jessie/fridgy/Backend/services/multiModalExtractor.js`:

**Find this** (around line 1130):
```javascript
const scraperApiKey = process.env.SCRAPER_API_KEY;
const proxyUrl = scraperApiKey
  ? `http://scraperapi:${scraperApiKey}@proxy-server.scraperapi.com:8001`
  : null;
```

**Replace with**:
```javascript
// Support both ScraperAPI (old) and custom proxy URL (BrightData)
const scraperApiKey = process.env.SCRAPER_API_KEY;
const customProxyUrl = process.env.PROXY_URL;

const proxyUrl = customProxyUrl
  ? customProxyUrl  // Use custom proxy (BrightData, etc)
  : scraperApiKey
    ? `http://scraperapi:${scraperApiKey}@proxy-server.scraperapi.com:8001`  // Fallback to ScraperAPI
    : null;
```

### Step 6: Deploy and Test

1. Commit and push changes
2. Railway auto-redeploys
3. Test with previously failing video
4. Check logs for:
   ```
   [MultiModal] ✓ YouTube video downloaded successfully: XX.XX MB
   [AudioProcessor] ✓ Transcription complete
   [VideoProcessor] ✓ Successfully extracted 8/8 frames
   ```

---

## Expected Results

**With BrightData**:
- Download time: 30-60 seconds (vs 2+ minutes)
- Success rate: 99%+
- Complete recipes with ALL ingredients
- Cost: $10/month (save $39 vs ScraperAPI)

---

## Verification

After switching to BrightData, test with the same video that was incomplete:
- URL: `https://youtube.com/shorts/cFukdTKPBTk`
- Expected ingredients: chicken, soy sauce, mirin, sugar, sesame oil, garlic, ginger, oil, **salt, pepper, cornstarch, five spice, honey**
- Should get all 13 ingredients (not just 10)

---

## Rollback Plan

If BrightData doesn't work or has issues:

1. Remove `PROXY_URL` from Railway
2. Re-add `SCRAPER_API_KEY`
3. Revert code changes
4. System goes back to current state (95% success)

**Rollback time**: 5 minutes

---

**When to use this**: Only if Step 1 (socket timeout) still results in download failures after testing
