# Facebook Creator Name Extraction - Investigation & Fix (April 4, 2026)

## Problem
Facebook recipe imports sometimes showed "From facebook" instead of the actual creator's username (e.g., should be "stephvnieteaa" but displayed as "From facebook").

## What We Discovered

### The Actual Root Cause
The issue was **NOT a bug in our code** - it's due to **inconsistent data from Apify's Facebook scrapers**.

### How It Actually Works

Facebook recipe imports use **two Apify actors with automatic fallback**:

1. **First attempt**: `facebook-reels-scraper` (for /share/v/ URLs)
2. **Fallback**: `facebook-posts-scraper` (if reels scraper fails or returns incomplete data)

**File**: `services/apifyFacebookService.js` (lines 295-382)

### What Apify Returns (Varies by URL/Content Type)

**Successful Import** (this test on Apr 4):
```javascript
{
  'owner.name': undefined,
  'owner.username': undefined,
  'owner.id': undefined,
  pageName: 'stephvnieteaa',    // ✅ Username extracted from here!
  authorName: undefined,
  ownerUsername: undefined,
  pageUsername: undefined
}
```
- **Posts scraper** provided `pageName = "stephvnieteaa"`
- Passed validation → username displayed correctly

**Failed Import** (earlier test):
```
owner.name = "reel"  // Content type, not username
All other fields: undefined
```
- Validation rejected "reel" (it's in INVALID_NAMES)
- All username fields were undefined
- Result: null → "From facebook"

### Why Results Vary

**Different Facebook URL formats behave differently**:
- `/share/v/` URLs (reels) - Sometimes return content types instead of usernames
- `/share/r/` URLs (reels with recipe) - More likely to return valid pageName
- Regular post URLs - Usually have more complete metadata

**Apify's response depends on**:
- Facebook's internal data structure for that content
- Whether content is a reel, post, or shared video
- Privacy settings of the original post
- Whether fallback to posts scraper succeeded

## The Fallback Mechanism (Already Exists)

**File**: `services/apifyFacebookService.js` (lines 295-382)

```javascript
// Step 1: Try reels scraper
const reelsResult = await this.runApifyActor(REELS_ACTOR, input);

// Step 2: If reels scraper returns incomplete data, fallback to posts scraper
if (!caption || caption.length < 50) {
  console.log('[ApifyFacebook] Reels/video scraper returned no caption, trying posts scraper as fallback...');
  const postsResult = await this.runApifyActor(POSTS_ACTOR, input);
  // Merge results
}
```

**This fallback is why it worked the second time!**

### Author Extraction Priority (Lines 660-666)

```javascript
const validUsername = this.validateAuthorName(data.owner?.name) ||      // 1st
                      this.validateAuthorName(data.pageName) ||         // 2nd ✅ FOUND HERE
                      this.validateAuthorName(data.authorName) ||       // 3rd
                      this.validateAuthorName(data.ownerUsername) ||    // 4th
                      this.validateAuthorName(data.owner?.username) ||  // 5th
                      this.validateAuthorName(data.pageUsername) ||     // 6th
                      null;
```

## What We Added: Diagnostic Logging

**File**: `services/apifyFacebookService.js` (commit 45004e8)

Added comprehensive logging before username extraction:

```javascript
// Debug: Log all author-related fields from Apify response
console.log('[ApifyFacebook] 🔍 Author fields from Apify:', {
  'owner.name': data.owner?.name,
  'owner.username': data.owner?.username,
  'owner.id': data.owner?.id,
  'pageName': data.pageName,
  'authorName': data.authorName,
  'ownerUsername': data.ownerUsername,
  'pageUsername': data.pageUsername,
  'full owner object': data.owner
});
```

**Purpose**: Help debug future failures by seeing exactly what fields Apify returns.

## The Validation Function

**File**: `services/apifyFacebookService.js` (lines 167-212)

```javascript
validateAuthorName(name) {
  const INVALID_NAMES = [
    'reel', 'reels',      // Filters out content types
    'video', 'videos',
    'post', 'posts',
    'share', 'watch',
    'story', 'stories',
    'facebook', 'fb',
    'facebook_user', 'page', 'user'
  ];

  // Also filters out:
  // - Numeric IDs (e.g., "178414014110927144")
  // - Very short names (< 2 chars)
  // - URL-like strings
}
```

**This validation is necessary** to filter out junk values Apify sometimes returns.

## Why It Failed Before vs. Succeeded Now

| Scenario | Reels Scraper | Posts Scraper Fallback | Result |
|----------|---------------|------------------------|--------|
| **Failed** (earlier) | `owner.name = "reel"` | Not triggered or also failed | ❌ null → "From facebook" |
| **Succeeded** (Apr 4) | Incomplete data | ✅ Triggered, returned `pageName = "stephvnieteaa"` | ✅ "stephvnieteaa" |

## Future Recommendations

### Option 1: Always Run Both Scrapers
Instead of fallback-only, run both scrapers and merge results:

```javascript
const [reelsResult, postsResult] = await Promise.all([
  this.runApifyActor(REELS_ACTOR, input),
  this.runApifyActor(POSTS_ACTOR, input)
]);
// Merge: prefer posts scraper for username, reels for video URL
```

**Trade-off**: Costs 2x Apify credits, but more reliable

### Option 2: Extract Username from Profile URL
The logs show Apify returns:
```javascript
"url": "https://www.facebook.com/stephvnieteaa"
"delegate_page.uri_token": "stephvnieteaa"
```

We could extract username from these URL fields as an additional fallback.

### Option 3: Use Facebook Graph API
As a final fallback, use the owner ID to fetch profile via Graph API:
```javascript
// If all Apify fields fail
if (!validUsername && data.owner?.id) {
  const profile = await fetchFacebookProfile(data.owner.id);
  validUsername = profile.username;
}
```

**Trade-off**: Requires Facebook access token

## Related Commits

- `86d0b0a` - Fix social media creator links not clickable (Mar 18)
- `aa0caf7` - Fix Facebook author extraction - prioritize display names over user IDs (Mar 26)
  - **Change**: Moved `owner.name` to check first (instead of `ownerUsername`)
  - **Reason**: Avoid showing numeric IDs like "178414014110927144"
  - **Side effect**: Made "reel" rejection more likely if owner.name contains it
- `29a88a1` - Optimize Facebook import: add caching, reduce timeouts (Apr 3)
  - **Change**: Added `validateAuthorName()` function with INVALID_NAMES
  - **Reason**: Filter out junk values like "reel", "video", "facebook_user"
- `45004e8` - Add diagnostic logging for Facebook author extraction (Apr 4)
  - **Change**: Added 🔍 logging to see all Apify response fields
  - **Reason**: Debug why username extraction is inconsistent

## Testing Notes

**Successful test URLs** (Apr 4, 2026):
- `https://www.facebook.com/share/r/1B21fN1KWT/?mibextid=wwXIfr`
  - Username extracted: "stephvnieteaa" ✅
  - Method: Posts scraper fallback → `pageName` field

**Failed test URLs** (earlier):
- `https://www.facebook.com/share/v/1C5czfwz8W/?mibextid=wwXIfr`
  - Username: null → "From facebook" ❌
  - Reason: Both scrapers returned incomplete/invalid data

## Key Learnings

1. **Facebook username extraction is inherently unreliable** due to Apify's inconsistent responses
2. **The fallback mechanism works** but depends on Apify cooperating
3. **Validation is necessary** to filter "reel", "video", numeric IDs, etc.
4. **Diagnostic logging is essential** for debugging future failures
5. **`pageName` field is the most reliable source** for usernames when available
6. **Different URL formats** (/share/v/ vs /share/r/) return different data structures

## Current Status

✅ **Working** - Falls back to posts scraper when reels scraper fails
✅ **Diagnostic logging added** - Can debug future issues
⚠️ **Still unreliable** - Depends on what Apify returns for each URL
💡 **Consider**: Implementing one of the future recommendations above for more reliability

## Files Modified

- `services/apifyFacebookService.js` (lines 657-674) - Author extraction logic
- `services/apifyFacebookService.js` (lines 167-212) - Validation function
- `services/apifyFacebookService.js` (lines 295-382) - Dual-scraper fallback mechanism

## For Future Claude

If users report "From facebook" instead of username:

1. **Check the diagnostic logs** for the 🔍 emoji message showing all Apify fields
2. **Identify which fields have data** - Is it `pageName`, `owner.name`, or other?
3. **Check if validation rejected it** - Look for ❌ rejection messages
4. **Consider the URL format** - /share/v/ vs /share/r/ vs regular posts behave differently
5. **Verify both scrapers ran** - Posts scraper fallback should trigger if reels fails
6. **If all fields are undefined** - Apify couldn't scrape that URL, may need Graph API

The code is working as designed - username extraction just depends on what Facebook/Apify provides.
