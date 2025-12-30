const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');
const fetch = require('node-fetch');

class ApifyFacebookService {
  constructor() {
    this.apiToken = process.env.APIFY_API_TOKEN;
    // Facebook uses different actors for reels/videos vs posts
    this.reelsActorId = process.env.APIFY_FACEBOOK_REELS_ACTOR || 'apify~facebook-reels-scraper';
    this.postsActorId = process.env.APIFY_FACEBOOK_POSTS_ACTOR || 'apify~facebook-posts-scraper';
    // SHARED limit with Instagram
    this.freeLimit = parseInt(process.env.APIFY_FREE_TIER_LIMIT) || 50;
    this.timeoutSeconds = parseInt(process.env.APIFY_TIMEOUT_SECONDS) || 30;

    this.supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_ANON_KEY
    );
  }

  /**
   * Detect the content type from Facebook URL to choose appropriate actor
   * @param {string} url - Facebook URL
   * @returns {'reel' | 'video' | 'post'}
   */
  detectContentType(url) {
    const urlLower = url.toLowerCase();

    // Reel patterns
    if (urlLower.includes('/reel/') ||
        urlLower.includes('fb.watch') ||
        urlLower.includes('/share/r/')) {
      return 'reel';
    }

    // Video patterns
    if (urlLower.includes('/watch?v=') ||
        urlLower.includes('/watch/?v=') ||
        urlLower.includes('/videos/')) {
      return 'video';
    }

    // Default to post
    return 'post';
  }

  /**
   * Validate if URL is a Facebook URL
   * @param {string} url - URL to validate
   * @returns {boolean}
   */
  isFacebookUrl(url) {
    if (!url) return false;
    return /facebook\.com|fb\.watch|m\.facebook\.com/i.test(url);
  }

  /**
   * Helper method to validate image URLs
   */
  isValidImageUrl(url) {
    if (!url || typeof url !== 'string') return false;
    if (!url.startsWith('http')) return false;

    const validDomains = [
      'facebook.com',
      'fbcdn.net',
      'scontent',
      'cloudfront.net',
      'akamaihd.net',
      'akamaized.net',
      'fbsbx.com',
      'apifyusercontent.com'
    ];

    const hasValidDomain = validDomains.some(domain => url.includes(domain));
    if (!hasValidDomain) {
      console.log(`[ApifyFacebook] URL rejected - not from valid domain: ${url.substring(0, 50)}...`);
      return false;
    }

    return true;
  }

  /**
   * Fallback: Extract og:image from Facebook page HTML
   * Used when Apify doesn't return thumbnail images
   * Tries multiple URL variants and user agents for better success rate
   */
  async extractOgImage(facebookUrl) {
    // Try multiple URL variants - Facebook may respond differently to each
    const urlVariants = [
      facebookUrl,
      // Try converting share/v URL to reel URL format
      facebookUrl.replace('/share/v/', '/reel/'),
      // Try mobile URL (sometimes more accessible)
      facebookUrl.replace('www.facebook.com', 'm.facebook.com'),
      // Try without www
      facebookUrl.replace('https://www.facebook.com', 'https://facebook.com')
    ].filter((url, index, arr) => arr.indexOf(url) === index); // Remove duplicates

    // User agents to try - Facebook's crawler agent often gets better results
    const userAgents = [
      'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
      'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    ];

    const patterns = [
      /<meta\s+property=["']og:image["']\s+content=["']([^"']+)["']/i,
      /<meta\s+content=["']([^"']+)["']\s+property=["']og:image["']/i,
      /<meta\s+name=["']og:image["']\s+content=["']([^"']+)["']/i,
      // Also try twitter:image which Facebook sometimes populates
      /<meta\s+name=["']twitter:image["']\s+content=["']([^"']+)["']/i,
      /<meta\s+content=["']([^"']+)["']\s+name=["']twitter:image["']/i
    ];

    for (const url of urlVariants) {
      for (const userAgent of userAgents) {
        try {
          console.log('[ApifyFacebook] Trying og:image fetch:', url.substring(0, 60), 'with UA:', userAgent.substring(0, 30));

          const response = await fetch(url, {
            headers: {
              'User-Agent': userAgent,
              'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
              'Accept-Language': 'en-US,en;q=0.9'
            },
            timeout: 8000
          });

          if (!response.ok) {
            console.log('[ApifyFacebook] og:image fetch failed:', response.status);
            continue; // Try next combination
          }

          const html = await response.text();

          for (const pattern of patterns) {
            const match = html.match(pattern);
            if (match && match[1]) {
              const imageUrl = match[1].replace(/&amp;/g, '&'); // Decode HTML entities
              // Validate it's a proper image URL
              if (imageUrl.startsWith('http') && !imageUrl.includes('rsrc.php')) {
                console.log('[ApifyFacebook] Found og:image:', imageUrl.substring(0, 80));
                return imageUrl;
              }
            }
          }
        } catch (error) {
          console.log('[ApifyFacebook] og:image attempt failed:', error.message);
          continue; // Try next combination
        }
      }
    }

    console.log('[ApifyFacebook] No og:image found after all attempts');
    return null;
  }

  async extractFromUrl(facebookUrl, userId) {
    console.log('[ApifyFacebook] Starting extraction for:', facebookUrl);
    console.log('[ApifyFacebook] User ID:', userId);

    try {
      // Check usage limits first (SHARED with Instagram)
      const canUse = await this.checkUsageLimit(userId);
      if (!canUse.allowed) {
        console.log('[ApifyFacebook] Usage limit exceeded:', canUse);
        return {
          success: false,
          error: 'Monthly limit reached for premium imports',
          limitExceeded: true,
          usage: canUse.usage
        };
      }

      // Check cache
      const cached = await this.checkCache(facebookUrl);
      if (cached) {
        console.log('[ApifyFacebook] Found cached result');
        return cached;
      }

      // Detect content type and choose actor
      const contentType = this.detectContentType(facebookUrl);
      const actorId = (contentType === 'post') ? this.postsActorId : this.reelsActorId;

      console.log('[ApifyFacebook] Content type:', contentType);
      console.log('[ApifyFacebook] Using actor:', actorId);

      // Start Apify actor run
      console.log('[ApifyFacebook] Starting Apify actor...');
      const runResponse = await this.startActorRun(actorId, facebookUrl, contentType);

      if (!runResponse.success) {
        console.error('[ApifyFacebook] Failed to start actor:', runResponse.error);
        return runResponse;
      }

      // Poll for results
      console.log('[ApifyFacebook] Polling for results, run ID:', runResponse.runId);
      const results = await this.pollForResults(actorId, runResponse.runId);

      if (!results.success) {
        console.error('[ApifyFacebook] Failed to get results:', results.error);
        return results;
      }

      // Parse and normalize results to match Instagram format
      let parsedData = await this.parseApifyResponse(results.data, contentType, facebookUrl);

      // FALLBACK: If reels scraper returned no caption, try posts scraper
      // This handles /share/r/ URLs that the reels scraper can't process
      if ((contentType === 'reel' || contentType === 'video') &&
          (!parsedData.caption || parsedData.caption.length === 0)) {
        console.log('[ApifyFacebook] Reels/video scraper returned no caption, trying posts scraper as fallback...');

        try {
          const fallbackRunResponse = await this.startActorRun(this.postsActorId, facebookUrl, 'post');
          if (fallbackRunResponse.success) {
            const fallbackResults = await this.pollForResults(this.postsActorId, fallbackRunResponse.runId);
            if (fallbackResults.success && fallbackResults.data) {
              const fallbackParsed = await this.parseApifyResponse(fallbackResults.data, 'post', facebookUrl);
              if (fallbackParsed.caption && fallbackParsed.caption.length > 0) {
                console.log('[ApifyFacebook] Posts scraper fallback successful, got caption with', fallbackParsed.caption.length, 'chars');
                // Merge: keep original images if fallback has none
                if (parsedData.images?.length > 0 && (!fallbackParsed.images || fallbackParsed.images.length === 0)) {
                  fallbackParsed.images = parsedData.images;
                }
                parsedData = fallbackParsed;
              } else {
                console.log('[ApifyFacebook] Posts scraper fallback also returned no caption');
              }
            }
          }
        } catch (fallbackError) {
          console.log('[ApifyFacebook] Posts scraper fallback failed:', fallbackError.message);
        }
      }

      // Increment usage (SHARED with Instagram)
      await this.incrementUsage(userId);

      // Cache the result
      await this.cacheResult(facebookUrl, parsedData);

      console.log('[ApifyFacebook] Extraction successful:', {
        hasVideo: !!parsedData.videoUrl,
        hasCaption: !!parsedData.caption,
        imageCount: parsedData.images?.length || 0
      });

      return parsedData;

    } catch (error) {
      console.error('[ApifyFacebook] Extraction error:', error);
      return {
        success: false,
        error: error.message || 'Failed to extract from Facebook'
      };
    }
  }

  async startActorRun(actorId, facebookUrl, contentType) {
    try {
      // Different input formats for different actors
      let inputData;

      if (contentType === 'post') {
        // Posts scraper uses startUrls format
        inputData = {
          startUrls: [{ url: facebookUrl }],
          resultsLimit: 1
        };
      } else {
        // Reels/video scraper also uses startUrls format
        inputData = {
          startUrls: [{ url: facebookUrl }],
          resultsLimit: 1
        };
      }

      console.log('[ApifyFacebook] Sending input to actor:', JSON.stringify(inputData));

      const response = await axios.post(
        `https://api.apify.com/v2/acts/${actorId}/runs`,
        inputData,
        {
          headers: {
            'Authorization': `Bearer ${this.apiToken}`,
            'Content-Type': 'application/json'
          },
          params: {
            timeout: this.timeoutSeconds,
            memory: 256
          }
        }
      );

      return {
        success: true,
        runId: response.data.data.id,
        defaultDatasetId: response.data.data.defaultDatasetId
      };
    } catch (error) {
      console.error('[ApifyFacebook] Actor start error:', error.response?.data || error.message);
      return {
        success: false,
        error: error.response?.data?.error?.message || error.message
      };
    }
  }

  async pollForResults(actorId, runId, maxAttempts = 30) {
    let attempts = 0;
    const pollInterval = 2000;

    while (attempts < maxAttempts) {
      try {
        const statusResponse = await axios.get(
          `https://api.apify.com/v2/acts/${actorId}/runs/${runId}`,
          {
            headers: {
              'Authorization': `Bearer ${this.apiToken}`
            }
          }
        );

        const status = statusResponse.data.data.status;
        console.log(`[ApifyFacebook] Run status: ${status} (attempt ${attempts + 1}/${maxAttempts})`);

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
              error: 'Facebook is taking longer than usual. Please try again in a moment.',
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
        console.error('[ApifyFacebook] Polling error:', error.message);
        return {
          success: false,
          error: error.message
        };
      }
    }

    return {
      success: false,
      error: 'Facebook extraction timed out. Please try again.',
      isTimeout: true,
      technicalError: 'Polling timeout - actor still running after maximum attempts'
    };
  }

  /**
   * Parse Facebook Apify response and normalize to match Instagram format
   * This ensures multiModalExtractor works without changes
   * @param {object} data - Raw Apify response data
   * @param {string} contentType - 'reel', 'video', or 'post'
   * @param {string} originalUrl - Original Facebook URL for og:image fallback
   */
  async parseApifyResponse(data, contentType, originalUrl = null) {
    console.log('[ApifyFacebook] Raw response data:', JSON.stringify(data, null, 2));

    if (!data) {
      return {
        success: false,
        error: 'No data received from Apify'
      };
    }

    const extractionTimestamp = Date.now();
    let videoUrl = null;
    let videoDuration = null;
    let isVideo = false;
    let caption = '';
    const images = [];
    let extractionMethod = 'none';

    // PRIORITY 0: Check preferred_thumbnail first (most reliable for video posts)
    // This field contains the full URL with query parameters for authentication
    if (data.preferred_thumbnail?.image?.uri) {
      const thumbnailUri = data.preferred_thumbnail.image.uri;
      if (this.isValidImageUrl(thumbnailUri)) {
        console.log('[ApifyFacebook] Found preferred_thumbnail (best source):', thumbnailUri.substring(0, 80));
        images.push({ url: thumbnailUri, isApifyProxy: false });
        extractionMethod = 'preferred_thumbnail';
      }
    }

    // PRIORITY 1: Search entire response for image URLs (like Instagram approach)
    // This catches images that may be nested in unexpected locations
    const responseString = JSON.stringify(data);

    // Look for Apify proxy URLs (permanent, non-expiring)
    if (images.length === 0) {
      const apifyProxyMatch = responseString.match(/https:\/\/images\.apifyusercontent\.com\/[^"\\]+/);
      if (apifyProxyMatch) {
        console.log('[ApifyFacebook] Found Apify proxy URL (permanent):', apifyProxyMatch[0].substring(0, 80));
        images.push({ url: apifyProxyMatch[0], isApifyProxy: true });
        extractionMethod = 'apify_proxy';
      }
    }

    // Look for Facebook CDN image URLs if no better source found
    // IMPORTANT: Regex must capture query parameters (?...) as they contain auth tokens
    if (images.length === 0) {
      const fbImagePatterns = [
        // Match full URLs including query parameters (stop at " which ends the JSON string)
        /https:\/\/scontent[^"]*\.fbcdn\.net\/v\/[^"]*\.(?:jpg|jpeg|png|webp)(?:\?[^"]*)?/gi,
        /https:\/\/external[^"]*\.fbcdn\.net\/[^"]*\.(?:jpg|jpeg|png|webp)(?:\?[^"]*)?/gi
      ];
      for (const pattern of fbImagePatterns) {
        const matches = responseString.match(pattern);
        if (matches && matches.length > 0) {
          // Filter out small icons (profile pics, privacy icons, etc.)
          const validImage = matches.find(url => {
            // Skip URLs that look like small icons or profile pics
            const isIcon = url.includes('/rsrc.php/') ||
                          url.includes('_s.jpg') ||
                          url.includes('_t.jpg') ||
                          url.includes('/p36x36/') ||
                          url.includes('/p50x50/') ||
                          url.includes('/p40x40/') ||
                          url.includes('/p64x64/') ||
                          url.includes('_s40x40') ||
                          url.includes('_s64x64');
            return !isIcon && this.isValidImageUrl(url);
          });
          if (validImage) {
            // Decode HTML entities in URL (e.g., &amp; -> &)
            const decodedUrl = validImage.replace(/&amp;/g, '&');
            console.log('[ApifyFacebook] Found Facebook CDN image:', decodedUrl.substring(0, 80));
            images.push({ url: decodedUrl, isApifyProxy: false });
            extractionMethod = 'fb_cdn_search';
            break;
          }
        }
      }
    }

    // PRIORITY 2: Check attachments for video/photo thumbnails
    if (images.length === 0 && data.attachments && Array.isArray(data.attachments)) {
      for (const attachment of data.attachments) {
        const media = attachment?.media;
        if (media) {
          const thumbnailUrl = media.thumbnail_image?.uri ||
                              media.thumbnailUrl ||
                              media.preview_image?.uri ||
                              media.image?.uri ||
                              media.preferred_thumbnail?.image?.uri;
          if (thumbnailUrl && this.isValidImageUrl(thumbnailUrl)) {
            console.log('[ApifyFacebook] Found attachment thumbnail:', thumbnailUrl.substring(0, 80));
            images.push({ url: thumbnailUrl, isApifyProxy: thumbnailUrl.includes('apifyusercontent.com') });
            extractionMethod = 'attachment_thumbnail';
            break;
          }
        }
      }
    }

    if (contentType === 'reel' || contentType === 'video') {
      // Reels/video scraper response format
      videoUrl = data.videoUrl || data.shareable_url || data.video_url || null;
      videoDuration = data.length_in_second || data.duration || null;
      isVideo = true;
      caption = data.text || data.caption || data.description || '';

      // Extract thumbnail/image (check multiple possible field names) - only if not found by priority search
      if (images.length === 0) {
        const thumbnailUrl = data.thumbnail || data.thumbnailUrl || data.preview_image_url ||
                             data.thumbnailImage || data.coverImage || data.previewImage ||
                             data.image || data.preferred_thumbnail?.image?.uri || null;
        if (thumbnailUrl && this.isValidImageUrl(thumbnailUrl)) {
          images.push({
            url: thumbnailUrl,
            isApifyProxy: thumbnailUrl.includes('apifyusercontent.com')
          });
          extractionMethod = 'video_field_check';
        }
      }
    } else {
      // Posts scraper response format
      caption = data.postText || data.text || (typeof data.message === 'object' ? data.message?.text : data.message) || '';
      isVideo = false;

      // Extract images from media attachments - only if not found by priority search
      if (images.length === 0 && data.mediaAttachments && Array.isArray(data.mediaAttachments)) {
        for (const media of data.mediaAttachments) {
          if (media.url && this.isValidImageUrl(media.url)) {
            images.push({
              url: media.url,
              isApifyProxy: media.url.includes('apifyusercontent.com')
            });
            extractionMethod = 'media_attachments';
          }
        }
      }

      // Fallback to thumbnail (check multiple fields)
      if (images.length === 0) {
        const postThumbnail = data.thumbnail || data.preferred_thumbnail?.image?.uri;
        if (postThumbnail && this.isValidImageUrl(postThumbnail)) {
          images.push({
            url: postThumbnail,
            isApifyProxy: postThumbnail.includes('apifyusercontent.com')
          });
          extractionMethod = 'post_thumbnail';
        }
      }
    }

    // Final fallback: if still no images, try all possible thumbnail field names
    if (images.length === 0) {
      const fallbackThumbnail = data.thumbnail || data.thumbnailUrl ||
                                data.thumbnailImage || data.coverImage ||
                                data.previewImage || data.preview_image_url ||
                                data.image || data.preferred_thumbnail?.image?.uri;
      if (fallbackThumbnail && this.isValidImageUrl(fallbackThumbnail)) {
        console.log('[ApifyFacebook] Using fallback thumbnail:', fallbackThumbnail.substring(0, 80));
        images.push({
          url: fallbackThumbnail,
          isApifyProxy: fallbackThumbnail.includes('apifyusercontent.com')
        });
        extractionMethod = 'final_fallback';
      }
    }

    // OG:image fallback: fetch from Facebook page if still no images
    if (images.length === 0 && originalUrl) {
      const ogImageUrl = await this.extractOgImage(originalUrl);
      if (ogImageUrl && this.isValidImageUrl(ogImageUrl)) {
        console.log('[ApifyFacebook] Using og:image fallback');
        images.push({
          url: ogImageUrl,
          isApifyProxy: false,
          source: 'og:image'
        });
        extractionMethod = 'og_image';
      }
    }

    // Extract author info (different field names between actors)
    const author = {
      username: data.ownerUsername || data.owner?.name || data.pageName || data.authorName || 'facebook_user',
      fullName: data.owner?.name || data.pageName || data.authorName || '',
      profilePic: data.owner?.profilePicUrl || data.ownerProfilePicUrl || ''
    };

    // Extract hashtags from caption
    const hashtags = this.extractHashtags(caption);

    // Video URL expiration tracking
    const videoUrlExpiry = videoUrl ? extractionTimestamp + (60 * 60 * 1000) : null;

    console.log('[ApifyFacebook] Parsed data:', {
      hasCaption: !!caption,
      captionLength: caption.length,
      hasVideo: isVideo,
      videoUrl: !!videoUrl,
      videoDuration,
      imageCount: images.length,
      imageExtractionMethod: extractionMethod,
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
      likes: data.likesCount || data.likes || 0,
      comments: data.commentsCount || data.comments || 0,
      viewCount: data.playCountRounded || data.viewCount || data.views || 0,
      timestamp: data.timestamp || data.createdAt,
      isVideo: isVideo,
      extractedWithApify: true,
      platform: 'facebook',
      requiresImmediateProcessing: isVideo
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
  // USAGE TRACKING - SHARED WITH INSTAGRAM
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
        console.error('[ApifyFacebook] Usage check error:', error);
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
      console.error('[ApifyFacebook] Usage limit check error:', error);
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

      console.log('[ApifyFacebook] Usage incremented for user:', userId);
    } catch (error) {
      console.error('[ApifyFacebook] Failed to increment usage:', error);
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
        console.error('[ApifyFacebook] Get usage stats error:', error);
      }

      const used = data?.usage_count || 0;
      return {
        used: used,
        limit: this.freeLimit,
        remaining: Math.max(0, this.freeLimit - used),
        percentage: Math.round((used / this.freeLimit) * 100)
      };
    } catch (error) {
      console.error('[ApifyFacebook] Get usage stats error:', error);
      return {
        used: 0,
        limit: this.freeLimit,
        remaining: this.freeLimit,
        percentage: 0
      };
    }
  }

  // ============================================
  // CACHING - Uses facebook_cache table
  // ============================================

  async checkCache(url) {
    try {
      const { data } = await this.supabase
        .from('facebook_cache')
        .select('data')
        .eq('url', url)
        .eq('extracted_with_apify', true)
        .gt('expires_at', new Date().toISOString())
        .single();

      if (data) {
        console.log('[ApifyFacebook] Cache hit for URL:', url);
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
        .from('facebook_cache')
        .upsert({
          url: url,
          data: JSON.stringify(data),
          extracted_with_apify: true,
          expires_at: expiresAt.toISOString(),
          created_at: new Date().toISOString()
        }, {
          onConflict: 'url'
        });

      console.log('[ApifyFacebook] Result cached for URL:', url);
    } catch (error) {
      console.error('[ApifyFacebook] Cache error:', error);
    }
  }

  // ============================================
  // IMAGE DOWNLOAD - Similar to Instagram
  // ============================================

  async downloadFacebookImage(imageUrl, recipeId, userId) {
    if (!imageUrl || !recipeId || !userId) {
      console.error('[ApifyFacebook] downloadFacebookImage: Missing required parameters');
      return null;
    }

    try {
      console.log('[ApifyFacebook] Downloading image:', imageUrl.substring(0, 100));

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
              'Referer': 'https://www.facebook.com/'
            }
      };

      const response = await fetch(imageUrl, fetchOptions);

      if (!response.ok) {
        console.error('[ApifyFacebook] Failed to download image:', response.status);
        return null;
      }

      const contentType = response.headers.get('content-type') || '';
      if (!contentType.startsWith('image/')) {
        console.error('[ApifyFacebook] Response is not an image:', contentType);
        return null;
      }

      const imageBuffer = await response.buffer();

      if (!imageBuffer || imageBuffer.length === 0) {
        console.error('[ApifyFacebook] Downloaded image buffer is empty');
        return null;
      }

      // Check file size (limit to 10MB)
      if (imageBuffer.length > 10 * 1024 * 1024) {
        console.error('[ApifyFacebook] Image too large');
        return null;
      }

      // Determine extension
      let extension = 'jpg';
      if (contentType.includes('png')) extension = 'png';
      else if (contentType.includes('webp')) extension = 'webp';
      else if (contentType.includes('gif')) extension = 'gif';

      const timestamp = Date.now();
      const fileName = `${userId}/${recipeId}-fb-${timestamp}.${extension}`;

      console.log('[ApifyFacebook] Uploading to Supabase storage:', fileName);

      const { error: uploadError } = await this.supabase.storage
        .from('recipe-images')
        .upload(fileName, imageBuffer, {
          contentType: contentType || 'image/jpeg',
          cacheControl: '31536000',
          upsert: false
        });

      if (uploadError) {
        console.error('[ApifyFacebook] Supabase upload error:', uploadError);
        return null;
      }

      const { data: urlData } = this.supabase.storage
        .from('recipe-images')
        .getPublicUrl(fileName);

      if (!urlData || !urlData.publicUrl) {
        console.error('[ApifyFacebook] Failed to get public URL');
        return null;
      }

      console.log('[ApifyFacebook] Image uploaded successfully:', urlData.publicUrl);
      return urlData.publicUrl;

    } catch (error) {
      console.error('[ApifyFacebook] Error downloading/uploading image:', error.message);
      return null;
    }
  }
}

module.exports = new ApifyFacebookService();
