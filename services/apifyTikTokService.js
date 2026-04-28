const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');
const fetch = require('node-fetch');

class ApifyTikTokService {
  constructor() {
    this.apiToken = process.env.APIFY_API_TOKEN;
    // apidojo: pay-per-result ($0.0001/scrape), 4.9 rating, 7.7M runs
    this.actorId = process.env.APIFY_TIKTOK_ACTOR || 'apidojo~tiktok-scraper';
    // SHARED limit with Instagram/Facebook/YouTube
    this.freeLimit = parseInt(process.env.APIFY_FREE_TIER_LIMIT) || 50;
    // Reduced to fit within Railway's 30s timeout
    this.timeoutSeconds = parseInt(process.env.APIFY_TIMEOUT_SECONDS) || 20;

    this.supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_ANON_KEY
    );
  }

  /**
   * Validate if URL is a TikTok URL
   * @param {string} url - URL to validate
   * @returns {boolean}
   */
  isTikTokUrl(url) {
    if (!url) return false;
    return /tiktok\.com|vm\.tiktok\.com|vt\.tiktok\.com|m\.tiktok\.com/i.test(url);
  }

  /**
   * Helper method to validate image URLs from TikTok CDN
   */
  isValidImageUrl(url) {
    if (!url || typeof url !== 'string') return false;
    if (!url.startsWith('http')) return false;

    const validDomains = [
      'tiktokcdn.com',
      'tiktokcdn-us.com',
      'p16-sign',
      'p77-sign',
      'p19-sign',
      'muscdn.com',
      'apifyusercontent.com'
    ];

    const hasValidDomain = validDomains.some(domain => url.includes(domain));
    if (!hasValidDomain) {
      console.log(`[ApifyTikTok] URL rejected - not from valid domain: ${url.substring(0, 50)}...`);
      return false;
    }

    return true;
  }

  /**
   * Validate and filter invalid author names
   * TikTok Apify responses sometimes return content-type keywords instead of actual usernames
   * @param {string} name - Author name to validate
   * @returns {string|null} - Valid name or null if invalid
   */
  validateAuthorName(name) {
    if (!name || typeof name !== 'string') {
      return null;
    }

    const INVALID_NAMES = [
      'video', 'videos',
      'tiktok', 'tiktok_user',
      'fyp', 'foryou', 'foryoupage',
      'duet', 'stitch',
      'user', 'unknown'
    ];

    const normalized = name.toLowerCase().trim();

    if (INVALID_NAMES.includes(normalized)) {
      console.log(`[ApifyTikTok] Rejected invalid author name: "${name}"`);
      return null;
    }

    if (/^\d+$/.test(normalized)) {
      console.log(`[ApifyTikTok] Rejected numeric ID as author: "${name}"`);
      return null;
    }

    if (normalized.length < 2) {
      console.log(`[ApifyTikTok] Rejected too-short author name: "${name}"`);
      return null;
    }

    if (normalized.includes('http') || normalized.includes('www.')) {
      console.log(`[ApifyTikTok] Rejected URL-like author name: "${name}"`);
      return null;
    }

    return name.trim();
  }

  async extractFromUrl(tiktokUrl, userId) {
    console.log('[ApifyTikTok] Starting extraction for:', tiktokUrl);
    console.log('[ApifyTikTok] User ID:', userId);

    try {
      // Check usage limits (SHARED with Instagram/Facebook/YouTube)
      const canUse = await this.checkUsageLimit(userId);
      if (!canUse.allowed) {
        console.log('[ApifyTikTok] Usage limit exceeded:', canUse);
        return {
          success: false,
          error: 'Monthly limit reached for premium imports',
          limitExceeded: true,
          usage: canUse.usage
        };
      }

      // Check cache
      const cached = await this.checkCache(tiktokUrl);
      if (cached) {
        console.log('[ApifyTikTok] Found cached result');
        return cached;
      }

      // Start Apify actor run
      console.log('[ApifyTikTok] Starting Apify actor...');
      const runResponse = await this.startActorRun(tiktokUrl);

      if (!runResponse.success) {
        console.error('[ApifyTikTok] Failed to start actor:', runResponse.error);
        return runResponse;
      }

      // Poll for results
      console.log('[ApifyTikTok] Polling for results, run ID:', runResponse.runId);
      const results = await this.pollForResults(runResponse.runId);

      if (!results.success) {
        console.error('[ApifyTikTok] Failed to get results:', results.error);
        return results;
      }

      // Parse and normalize results to match the format multiModalExtractor expects
      const parsedData = this.parseApifyResponse(results.data);

      // If parsing found an error (e.g., post not found), return without incrementing usage
      if (!parsedData.success) {
        return parsedData;
      }

      // Increment usage (SHARED with Instagram/Facebook/YouTube)
      await this.incrementUsage(userId);

      // Cache the result
      await this.cacheResult(tiktokUrl, parsedData);

      console.log('[ApifyTikTok] Extraction successful:', {
        hasVideo: !!parsedData.videoUrl,
        hasCaption: !!parsedData.caption,
        imageCount: parsedData.images?.length || 0
      });

      return parsedData;

    } catch (error) {
      console.error('[ApifyTikTok] Extraction error:', error);
      return {
        success: false,
        error: error.message || 'Failed to extract from TikTok'
      };
    }
  }

  async startActorRun(tiktokUrl) {
    try {
      const inputData = {
        startUrls: [{ url: tiktokUrl }],
        maxItems: 1
      };

      console.log('[ApifyTikTok] Sending input to actor:', JSON.stringify(inputData));

      const response = await axios.post(
        `https://api.apify.com/v2/acts/${this.actorId}/runs`,
        inputData,
        {
          headers: {
            'Authorization': `Bearer ${this.apiToken}`,
            'Content-Type': 'application/json'
          },
          params: {
            timeout: this.timeoutSeconds,
            memory: 4096
          }
        }
      );

      return {
        success: true,
        runId: response.data.data.id,
        defaultDatasetId: response.data.data.defaultDatasetId
      };
    } catch (error) {
      console.error('[ApifyTikTok] Actor start error:', error.response?.data || error.message);
      return {
        success: false,
        error: error.response?.data?.error?.message || error.message
      };
    }
  }

  async pollForResults(runId, maxAttempts = 20) {
    let attempts = 0;
    const pollInterval = 1000; // 1s intervals (20 attempts * 1s = 20s max)

    while (attempts < maxAttempts) {
      try {
        const statusResponse = await axios.get(
          `https://api.apify.com/v2/acts/${this.actorId}/runs/${runId}`,
          {
            headers: {
              'Authorization': `Bearer ${this.apiToken}`
            }
          }
        );

        const status = statusResponse.data.data.status;
        console.log(`[ApifyTikTok] Run status: ${status} (attempt ${attempts + 1}/${maxAttempts})`);

        if (status === 'SUCCEEDED') {
          const datasetId = statusResponse.data.data.defaultDatasetId;
          const itemsResponse = await axios.get(
            `https://api.apify.com/v2/datasets/${datasetId}/items`,
            {
              headers: {
                'Authorization': `Bearer ${this.apiToken}`
              }
            }
          );

          return {
            success: true,
            data: itemsResponse.data[0]
          };
        } else if (status === 'FAILED' || status === 'ABORTED' || status === 'TIMED-OUT') {
          if (status === 'TIMED-OUT') {
            return {
              success: false,
              error: 'TikTok is taking longer than usual. Please try again in a moment.',
              isTimeout: true,
              technicalError: `Actor run timed-out after ${this.timeoutSeconds} seconds`
            };
          }

          return {
            success: false,
            error: `Actor run ${status.toLowerCase()}`
          };
        }

        await new Promise(resolve => setTimeout(resolve, pollInterval));
        attempts++;

      } catch (error) {
        console.error('[ApifyTikTok] Polling error:', error.message);
        return {
          success: false,
          error: error.message
        };
      }
    }

    return {
      success: false,
      error: 'TikTok extraction timed out. Please try again.',
      isTimeout: true,
      technicalError: 'Polling timeout - actor still running after maximum attempts'
    };
  }

  /**
   * Parse TikTok Scraper response and normalize to match the format
   * that multiModalExtractor.extractWithAllModalities() expects.
   *
   * Supports both apidojo and clockworks output formats with fallbacks:
   *   text/desc, videoUrl/webVideoUrl, authorMeta/author,
   *   videoMeta/covers, hashtags[], engagement metrics, createTime
   */
  parseApifyResponse(data) {
    console.log('[ApifyTikTok] Raw response data:', JSON.stringify(data, null, 2));

    if (!data) {
      return {
        success: false,
        error: 'No data received from Apify'
      };
    }

    // Handle actor-level errors (e.g., post not found, private video)
    if (data.noResults || data.error) {
      const msg = data.message || 'TikTok video not found or is private';
      console.log('[ApifyTikTok] Actor returned error:', msg);
      return {
        success: false,
        error: msg
      };
    }

    const extractionTimestamp = Date.now();

    // Caption / description
    // apidojo uses 'title', clockworks uses 'text'
    const caption = data.text || data.title || data.desc || data.description || data.caption || '';

    // Video URL - TikTok CDN URLs expire in ~2-5 minutes
    // apidojo uses video.url, clockworks uses videoUrl/webVideoUrl
    const videoUrl = data.video?.url || data.videoUrl || data.webVideoUrl || data.video?.playAddr || null;
    const videoDuration = data.video?.duration || data.videoMeta?.duration || data.duration || null;
    // CRITICAL: TikTok CDN tokens expire much faster than Facebook/Instagram (~3 min)
    const videoUrlExpiry = videoUrl ? extractionTimestamp + (3 * 60 * 1000) : null;

    // Cover/thumbnail images - check all known field names across actors
    const images = [];
    const coverCandidates = [
      data.videoMeta?.coverUrl,
      data.covers?.default,
      data.covers?.origin,
      data.covers?.dynamic,
      data.video?.cover,
      data.video?.dynamicCover,
      data.cover,
      data.coverUrl,
      data.thumbnailUrl,
      data.thumbnail,
      data.imageUrl
    ];

    for (const coverUrl of coverCandidates) {
      if (coverUrl && typeof coverUrl === 'string' && coverUrl.startsWith('http')) {
        const isApifyProxy = coverUrl.includes('apifyusercontent.com');
        if (isApifyProxy || this.isValidImageUrl(coverUrl)) {
          images.push({ url: coverUrl, isApifyProxy });
          console.log('[ApifyTikTok] Found cover image:', coverUrl.substring(0, 80));
          break;
        }
      }
    }

    // Fallback: search entire response for Apify proxy URLs
    if (images.length === 0) {
      const responseString = JSON.stringify(data);
      const apifyProxyMatch = responseString.match(/https:\/\/images\.apifyusercontent\.com\/[^"\\]+/);
      if (apifyProxyMatch) {
        console.log('[ApifyTikTok] Found Apify proxy URL (permanent):', apifyProxyMatch[0].substring(0, 80));
        images.push({ url: apifyProxyMatch[0], isApifyProxy: true });
      }
    }

    // Author info - support authorMeta (clockworks), author, and channel (apidojo)
    const authorMeta = data.authorMeta || data.author || data.channel || {};
    console.log('[ApifyTikTok] Author fields from Apify:', {
      'username': authorMeta.username,
      'name': authorMeta.name,
      'nickName': authorMeta.nickName,
      'uniqueId': authorMeta.uniqueId,
      'id': authorMeta.id
    });

    const validUsername = this.validateAuthorName(authorMeta.username) ||
                          this.validateAuthorName(authorMeta.uniqueId) ||
                          this.validateAuthorName(authorMeta.name) ||
                          this.validateAuthorName(authorMeta.nickName) ||
                          null;

    const author = {
      username: validUsername,
      fullName: this.validateAuthorName(authorMeta.name) ||
                this.validateAuthorName(authorMeta.nickName) ||
                this.validateAuthorName(authorMeta.nickname) || '',
      profilePic: authorMeta.avatar || authorMeta.avatarThumb || authorMeta.profilePic || ''
    };

    // Hashtags - support array of objects or strings
    let hashtags = [];
    if (Array.isArray(data.hashtags)) {
      hashtags = data.hashtags.map(h => {
        if (typeof h === 'string') return h;
        return h.name || h.title || h.hashtagName || '';
      }).filter(Boolean);
    } else if (Array.isArray(data.challenges)) {
      hashtags = data.challenges.map(c => c.title || c.name || '').filter(Boolean);
    }

    console.log('[ApifyTikTok] Parsed data:', {
      hasCaption: !!caption,
      captionLength: caption.length,
      hasVideo: true,
      videoUrl: !!videoUrl,
      videoDuration,
      imageCount: images.length,
      hashtagCount: hashtags.length,
      author: author.username
    });

    return {
      success: true,
      caption: caption,
      images: images,
      videoUrl: videoUrl,
      videoDuration: videoDuration,
      videoUrlExpiry: videoUrlExpiry,
      extractionTimestamp: extractionTimestamp,
      videos: videoUrl ? [{
        url: videoUrl,
        duration: videoDuration,
        expiry: videoUrlExpiry,
        isExpired: false
      }] : [],
      author: author,
      hashtags: hashtags,
      likes: data.likes || data.diggCount || 0,
      comments: data.comments || data.commentCount || 0,
      viewCount: data.views || data.playCount || data.viewCount || 0,
      timestamp: data.createTime || data.createTimeISO,
      isVideo: true, // TikTok is always video
      extractedWithApify: true,
      platform: 'tiktok',
      requiresImmediateProcessing: true // Video URLs expire fast - process immediately
    };
  }

  /**
   * Extract hashtags from text
   */
  extractHashtags(text) {
    if (!text || typeof text !== 'string') return [];
    const matches = text.match(/#\w+/g) || [];
    return matches.map(h => h.slice(1));
  }

  // ============================================
  // USAGE TRACKING - SHARED WITH ALL PLATFORMS
  // Uses same apify_usage table for combined limit
  // ============================================

  async checkUsageLimit(userId) {
    try {
      const currentMonth = new Date().toISOString().slice(0, 7);

      const { data: usageData, error } = await this.supabase
        .from('apify_usage')
        .select('usage_count')
        .eq('user_id', userId)
        .eq('month_year', currentMonth)
        .single();

      if (error && error.code !== 'PGRST116') {
        console.error('[ApifyTikTok] Usage check error:', error);
      }

      const currentUsage = usageData?.usage_count || 0;
      const remaining = this.freeLimit - currentUsage;

      return {
        allowed: currentUsage < this.freeLimit,
        usage: {
          used: currentUsage,
          limit: this.freeLimit,
          remaining: Math.max(0, remaining)
        }
      };
    } catch (error) {
      console.error('[ApifyTikTok] Usage limit check error:', error);
      return {
        allowed: true,
        usage: {
          used: 0,
          limit: this.freeLimit,
          remaining: this.freeLimit
        }
      };
    }
  }

  async incrementUsage(userId) {
    try {
      const currentMonth = new Date().toISOString().slice(0, 7);

      const { error } = await this.supabase
        .from('apify_usage')
        .upsert({
          user_id: userId,
          month_year: currentMonth,
          usage_count: 1,
          last_used: new Date().toISOString()
        }, {
          onConflict: 'user_id,month_year',
          count: 'exact'
        });

      if (!error) {
        await this.supabase.rpc('increment_apify_usage', {
          p_user_id: userId,
          p_month_year: currentMonth
        });
      }

      console.log('[ApifyTikTok] Usage incremented for user:', userId);
    } catch (error) {
      console.error('[ApifyTikTok] Failed to increment usage:', error);
    }
  }

  async getUsageStats(userId) {
    try {
      const currentMonth = new Date().toISOString().slice(0, 7);

      const { data, error } = await this.supabase
        .from('apify_usage')
        .select('usage_count')
        .eq('user_id', userId)
        .eq('month_year', currentMonth)
        .single();

      if (error && error.code !== 'PGRST116') {
        console.error('[ApifyTikTok] Get usage stats error:', error);
      }

      const used = data?.usage_count || 0;
      return {
        used: used,
        limit: this.freeLimit,
        remaining: Math.max(0, this.freeLimit - used),
        percentage: Math.round((used / this.freeLimit) * 100)
      };
    } catch (error) {
      console.error('[ApifyTikTok] Get usage stats error:', error);
      return {
        used: 0,
        limit: this.freeLimit,
        remaining: this.freeLimit,
        percentage: 0
      };
    }
  }

  // ============================================
  // CACHING - Uses tiktok_cache table
  // ============================================

  async checkCache(url) {
    try {
      const { data } = await this.supabase
        .from('tiktok_cache')
        .select('data')
        .eq('url', url)
        .eq('extracted_with_apify', true)
        .gt('expires_at', new Date().toISOString())
        .single();

      if (data) {
        console.log('[ApifyTikTok] Cache hit for URL:', url);
        return JSON.parse(data.data);
      }
    } catch (error) {
      // Cache miss is expected
    }
    return null;
  }

  async cacheResult(url, data) {
    try {
      const expiresAt = new Date();
      expiresAt.setHours(expiresAt.getHours() + 24);

      await this.supabase
        .from('tiktok_cache')
        .upsert({
          url: url,
          data: JSON.stringify(data),
          extracted_with_apify: true,
          expires_at: expiresAt.toISOString(),
          created_at: new Date().toISOString()
        }, {
          onConflict: 'url'
        });

      console.log('[ApifyTikTok] Result cached for URL:', url);
    } catch (error) {
      console.error('[ApifyTikTok] Cache error:', error);
    }
  }

  // ============================================
  // IMAGE DOWNLOAD - Download and store in Supabase
  // ============================================

  async downloadTikTokImage(imageUrl, recipeId, userId) {
    if (!imageUrl || !recipeId || !userId) {
      console.error('[ApifyTikTok] downloadTikTokImage: Missing required parameters');
      return null;
    }

    try {
      console.log('[ApifyTikTok] Downloading image:', imageUrl.substring(0, 100));

      const isApifyProxy = imageUrl.includes('apifyusercontent.com');

      const fetchOptions = {
        timeout: 30000,
        headers: isApifyProxy
          ? { 'Accept': 'image/*,*/*;q=0.8' }
          : {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
              'Accept': 'image/webp,image/apng,image/*,*/*;q=0.8',
              'Accept-Language': 'en-US,en;q=0.9',
              'Cache-Control': 'no-cache',
              'Referer': 'https://www.tiktok.com/'
            }
      };

      const response = await fetch(imageUrl, fetchOptions);

      if (!response.ok) {
        console.error('[ApifyTikTok] Failed to download image:', response.status);
        return null;
      }

      const contentType = response.headers.get('content-type') || '';
      if (!contentType.startsWith('image/')) {
        console.error('[ApifyTikTok] Response is not an image:', contentType);
        return null;
      }

      const imageBuffer = await response.buffer();

      if (!imageBuffer || imageBuffer.length === 0) {
        console.error('[ApifyTikTok] Downloaded image buffer is empty');
        return null;
      }

      // Check file size (limit to 10MB)
      if (imageBuffer.length > 10 * 1024 * 1024) {
        console.error('[ApifyTikTok] Image too large');
        return null;
      }

      // Determine extension
      let extension = 'jpg';
      if (contentType.includes('png')) extension = 'png';
      else if (contentType.includes('webp')) extension = 'webp';
      else if (contentType.includes('gif')) extension = 'gif';

      const timestamp = Date.now();
      const fileName = `${userId}/${recipeId}-tt-${timestamp}.${extension}`;

      console.log('[ApifyTikTok] Uploading to Supabase storage:', fileName);

      const { error: uploadError } = await this.supabase.storage
        .from('recipe-images')
        .upload(fileName, imageBuffer, {
          contentType: contentType || 'image/jpeg',
          cacheControl: '31536000',
          upsert: false
        });

      if (uploadError) {
        console.error('[ApifyTikTok] Supabase upload error:', uploadError);
        return null;
      }

      const { data: urlData } = this.supabase.storage
        .from('recipe-images')
        .getPublicUrl(fileName);

      if (!urlData || !urlData.publicUrl) {
        console.error('[ApifyTikTok] Failed to get public URL');
        return null;
      }

      console.log('[ApifyTikTok] Image uploaded successfully:', urlData.publicUrl);
      return urlData.publicUrl;

    } catch (error) {
      console.error('[ApifyTikTok] Error downloading/uploading image:', error.message);
      return null;
    }
  }
}

module.exports = new ApifyTikTokService();
