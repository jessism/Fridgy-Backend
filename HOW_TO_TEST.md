# How to Test YouTube Extraction Fix

You have **3 easy ways** to test the fix:

---

## Option 1: Simple Node.js Script (Easiest)

Run the test script I created:

```bash
cd /Users/jessie/fridgy/Backend

# If you have a test token:
TEST_AUTH_TOKEN=your_jwt_token node test-youtube-full.js

# Or without token (will test auth protection):
node test-youtube-full.js
```

**What it does:**
- Tests the failing video: `h6VO3aXOHd8`
- Shows detailed results
- Verifies error handling
- Displays recipe extracted

---

## Option 2: Using Your Mobile App (Most Realistic)

This is the BEST way to test because it's how real users will experience it:

1. **Open your Trackabite app**
2. **Go to Import/Add Recipe**
3. **Enter the failing video URL:**
   ```
   https://www.youtube.com/watch?v=h6VO3aXOHd8
   ```
4. **Tap Import**

**What to expect:**
- Recipe imports successfully ✅
- Shows: "Wife me up Chili Garlic Noodles"
- Has 5+ ingredients (noodles, oil, chili flakes, soy sauce, etc.)
- Has cooking steps
- **NO ERROR** (before it would crash)

---

## Option 3: Direct API Call with curl

If you have an auth token:

```bash
# Get your auth token first (from app or database)
TOKEN="your_jwt_token_here"

# Test the API
curl -X POST http://localhost:5000/api/youtube-recipes/multi-modal-extract \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"url":"https://www.youtube.com/watch?v=h6VO3aXOHd8"}' \
  | jq '.'
```

**Success looks like:**
```json
{
  "success": true,
  "recipe": {
    "title": "\"Wife me up\" Chili Garlic Noodles",
    "servings": 2,
    "readyInMinutes": 15,
    "extendedIngredients": [ ... ],
    "analyzedInstructions": [ ... ]
  },
  "confidence": 0.82,
  "extractionMethod": "audio-visual-fallback"
}
```

---

## Getting an Auth Token

### Method 1: From Your App
1. Open Trackabite app
2. Sign in
3. Check async storage or network requests for JWT token

### Method 2: Sign In via API
```bash
curl -X POST http://localhost:5000/api/auth/signin \
  -H "Content-Type: application/json" \
  -d '{
    "email": "your_test_user@example.com",
    "password": "your_password"
  }'
```

Copy the `token` from the response.

### Method 3: Create Test User
```bash
curl -X POST http://localhost:5000/api/auth/signup \
  -H "Content-Type: application/json" \
  -d '{
    "email": "test@example.com",
    "password": "testpass123",
    "firstName": "Test",
    "lastName": "User"
  }'
```

---

## What to Look For

### ✅ Success Signs (Before Fix: Would Crash)

**In Logs:**
```
[ApifyYouTube] Extracting transcript (FREE npm) for: h6VO3aXOHd8
[ApifyYouTube] Failed to get transcript: ...
[ApifyYouTube] No transcript available, will use audio-visual fallback if needed
[MultiModal] Extraction path decision: { ... }
[MultiModal] No text available - routing to audio-visual extraction
[AudioProcessor] Extracting audio from video...
[AudioProcessor] Transcribing audio with OpenRouter Gemini...
[AudioProcessor] ✓ Transcription complete
```

**In Response:**
- ✅ Recipe extracted
- ✅ Has 5+ ingredients
- ✅ Has 3+ cooking steps
- ✅ `extractionMethod: "audio-visual-fallback"`
- ✅ Processing time < 30 seconds

### 🚨 Red Flags (Should NOT Happen)

```
InnertubeError: CompositeVideoPrimaryInfo not found!
```
**This error should NEVER appear anymore!**

If you see it:
- youtubei.js didn't update properly
- Run: `npm list youtubei.js` (should show v17.0.1)

---

## Quick Test Commands

```bash
# Check youtubei.js version
npm list youtubei.js
# Should show: youtubei.js@17.0.1

# Run simple test
node test-youtube-full.js

# Check server is running
curl http://localhost:5000/api/health

# Watch server logs
tail -f /tmp/claude/-Users-jessie-trackabite-mobile/tasks/b9c38e9.output
```

---

## Testing on Production (Railway)

Once deployed to Railway:

```bash
# Replace with your Railway URL
PROD_URL="https://your-app.railway.app"
TOKEN="your_token"

curl -X POST $PROD_URL/api/youtube-recipes/multi-modal-extract \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"url":"https://www.youtube.com/watch?v=h6VO3aXOHd8"}' \
  | jq '.'
```

Check Railway logs:
```bash
railway logs
```

---

## Troubleshooting

**Q: "Token expired" error?**
- A: Get a fresh token (tokens expire after some time)

**Q: "Auth token is missing" error?**
- A: Check Authorization header format: `Bearer your_token`

**Q: Still seeing CompositeVideoPrimaryInfo error?**
- A: Check `npm list youtubei.js` - should be v17.0.1
- A: Run `npm install` again
- A: Check Railway deployment finished

**Q: Recipe quality is poor?**
- A: This is expected for videos without transcripts
- A: Audio-visual extraction is a fallback, not as good as text
- A: Check logs to see which extraction method was used

---

## Expected Results

| Video Type | Extraction Method | Cost | Quality |
|------------|------------------|------|---------|
| With transcript | Text-based | Free | ⭐⭐⭐⭐⭐ |
| No transcript (h6VO3aXOHd8) | Audio-visual | $0.0006 | ⭐⭐⭐⭐ |
| Silent video | Keyframes-only | $0.0003 | ⭐⭐⭐ |

**The key fix**: NO MORE CRASHES regardless of extraction method!

---

## Next Steps After Testing

1. ✅ Verify fix works locally
2. ✅ Check Railway deployment
3. ✅ Test with mobile app
4. ✅ Monitor logs for 24 hours
5. ✅ Track extraction success rates

Happy testing! 🎉
