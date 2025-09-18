const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');
const fetch = require('node-fetch'); // For downloading images

class ApifyInstagramService {
  constructor() {
    this.apiToken = process.env.APIFY_API_TOKEN;
    // Use the correct Instagram scraper from environment or default
    this.actorId = process.env.APIFY_ACTOR_ID || 'apify~instagram-scraper';
    this.freeLimit = parseInt(process.env.APIFY_FREE_TIER_LIMIT) || 50;
    this.timeoutSeconds = parseInt(process.env.APIFY_TIMEOUT_SECONDS) || 30;

    this.supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_ANON_KEY
    );
  }

  // Helper method to validate image URLs
  isValidImageUrl(url) {
    if (!url || typeof url !== 'string') return false;

    // Must be HTTP/HTTPS
    if (!url.startsWith('http')) return false;

    // Should contain Instagram domain or CDN
    const validDomains = [
      'instagram.com',
      'cdninstagram.com',
      'fbcdn.net',
      'scontent',
      'ig.me'
    ];

    const hasValidDomain = validDomains.some(domain => url.includes(domain));
    if (!hasValidDomain) {
      console.log(`[ApifyInstagram] URL rejected - not from Instagram domain: ${url.substring(0, 50)}...`);
      return false;
    }

    // Should look like an image (common extensions or patterns)
    const imagePatterns = [
      /\.(jpg|jpeg|png|gif|webp)/i,  // Common image extensions
      /\/s\d+x\d+\//,                // Instagram size pattern
      /scontent.*\.jpg/i,            // Instagram CDN pattern
      /\.fbcdn\.net.*\.(jpg|png)/i   // Facebook CDN pattern
    ];

    const hasImagePattern = imagePatterns.some(pattern => pattern.test(url));
    if (!hasImagePattern) {
      console.log(`[ApifyInstagram] URL rejected - doesn't match image patterns: ${url.substring(0, 50)}...`);
      return false;
    }

    return true;
  }

  async extractFromUrl(instagramUrl, userId) {
    console.log('[ApifyInstagram] Starting extraction for:', instagramUrl);
    console.log('[ApifyInstagram] User ID:', userId);

    try {
      // Check usage limits first
      const canUse = await this.checkUsageLimit(userId);
      if (!canUse.allowed) {
        console.log('[ApifyInstagram] Usage limit exceeded:', canUse);
        return {
          success: false,
          error: 'Monthly limit reached for premium imports',
          limitExceeded: true,
          usage: canUse.usage
        };
      }

      // Check cache
      const cached = await this.checkCache(instagramUrl);
      if (cached) {
        console.log('[ApifyInstagram] Found cached result');
        return cached;
      }

      // Start Apify actor run
      console.log('[ApifyInstagram] Starting Apify actor...');
      const runResponse = await this.startActorRun(instagramUrl);

      if (!runResponse.success) {
        console.error('[ApifyInstagram] Failed to start actor:', runResponse.error);
        return runResponse;
      }

      // Poll for results
      console.log('[ApifyInstagram] Polling for results, run ID:', runResponse.runId);
      const results = await this.pollForResults(runResponse.runId);

      if (!results.success) {
        console.error('[ApifyInstagram] Failed to get results:', results.error);
        return results;
      }

      // Parse and enhance results
      const parsedData = this.parseApifyResponse(results.data);

      // Increment usage
      await this.incrementUsage(userId);

      // Cache the result
      await this.cacheResult(instagramUrl, parsedData);

      console.log('[ApifyInstagram] Extraction successful:', {
        hasVideo: !!parsedData.videoUrl,
        hasCaption: !!parsedData.caption,
        imageCount: parsedData.images?.length || 0
      });

      return parsedData;

    } catch (error) {
      console.error('[ApifyInstagram] Extraction error:', error);
      return {
        success: false,
        error: error.message || 'Failed to extract from Instagram'
      };
    }
  }

  async startActorRun(instagramUrl) {
    try {
      // Simple direct URL format for Instagram scraper
      const inputData = {
        directUrls: [instagramUrl]
      };

      console.log('[ApifyInstagram] Sending input to actor:', inputData);

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
            memory: 256 // Use minimum memory for cost efficiency
          }
        }
      );

      return {
        success: true,
        runId: response.data.data.id,
        defaultDatasetId: response.data.data.defaultDatasetId
      };
    } catch (error) {
      console.error('[ApifyInstagram] Actor start error:', error.response?.data || error.message);
      return {
        success: false,
        error: error.response?.data?.error?.message || error.message
      };
    }
  }

  async pollForResults(runId, maxAttempts = 30) {
    let attempts = 0;
    const pollInterval = 2000; // 2 seconds

    while (attempts < maxAttempts) {
      try {
        // Check run status
        const statusResponse = await axios.get(
          `https://api.apify.com/v2/acts/${this.actorId}/runs/${runId}`,
          {
            headers: {
              'Authorization': `Bearer ${this.apiToken}`
            }
          }
        );

        const status = statusResponse.data.data.status;
        console.log(`[ApifyInstagram] Run status: ${status} (attempt ${attempts + 1}/${maxAttempts})`);

        if (status === 'SUCCEEDED') {
          // Get dataset items
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
            data: itemsResponse.data[0] // First item
          };
        } else if (status === 'FAILED' || status === 'ABORTED' || status === 'TIMED-OUT') {
          return {
            success: false,
            error: `Actor run ${status.toLowerCase()}`
          };
        }

        // Wait before next poll
        await new Promise(resolve => setTimeout(resolve, pollInterval));
        attempts++;

      } catch (error) {
        console.error('[ApifyInstagram] Polling error:', error.message);
        return {
          success: false,
          error: error.message
        };
      }
    }

    return {
      success: false,
      error: 'Timeout waiting for results'
    };
  }

  parseApifyResponse(data) {
    console.log('[ApifyInstagram] Raw response data:', JSON.stringify(data, null, 2));

    if (!data) {
      return {
        success: false,
        error: 'No data received from Apify'
      };
    }

    // Extract video URL with expiration tracking
    const videoUrl = data.videoUrl || null;
    const videoDuration = data.videoDuration || null;
    const isVideo = data.type === "Video";

    // Add timestamp for URL expiration tracking (Instagram URLs typically expire in ~1 hour)
    const extractionTimestamp = Date.now();
    const videoUrlExpiry = videoUrl ? extractionTimestamp + (60 * 60 * 1000) : null; // 1 hour expiry

    // Extract images - enhanced for video content and reels
    const images = [];

    // Priority order for image extraction (especially important for reels/videos)
    const imageUrlCandidates = [
      data.displayUrl,           // Primary display image
      data.thumbnailUrl,         // Video thumbnail
      data.videoThumbnail,       // Alternative video thumbnail
      data.imageUrl,             // Single image URL
      data.coverPhotoUrl,        // Cover photo for videos
      data.previewImageUrl       // Preview image
    ];

    // Try each candidate URL with enhanced validation
    for (const imageUrl of imageUrlCandidates) {
      if (imageUrl && typeof imageUrl === 'string' && imageUrl.startsWith('http')) {
        // Additional validation for Instagram image URLs
        if (this.isValidImageUrl(imageUrl)) {
          images.push({ url: imageUrl });
          console.log(`[ApifyInstagram] Found valid image URL: ${imageUrl.substring(0, 100)}...`);
          break; // Use first valid image found
        } else {
          console.log(`[ApifyInstagram] Invalid image URL rejected: ${imageUrl.substring(0, 100)}...`);
        }
      }
    }

    // If still no images, try extracting from arrays
    if (images.length === 0) {
      const imageArrays = [
        data.imageUrls,           // Array of image URLs
        data.images,              // Array of image objects
        data.displayUrls          // Array of display URLs
      ];

      for (const imageArray of imageArrays) {
        if (Array.isArray(imageArray) && imageArray.length > 0) {
          const firstImage = imageArray[0];
          const imageUrl = typeof firstImage === 'string' ? firstImage : firstImage?.url;
          if (imageUrl && imageUrl.startsWith('http') && this.isValidImageUrl(imageUrl)) {
            images.push({ url: imageUrl });
            console.log(`[ApifyInstagram] Found valid image URL from array: ${imageUrl.substring(0, 100)}...`);
            break;
          } else if (imageUrl) {
            console.log(`[ApifyInstagram] Invalid image URL from array rejected: ${imageUrl.substring(0, 100)}...`);
          }
        }
      }
    }

    // Extract caption - this contains the full recipe content
    const caption = data.caption || '';

    // Extract hashtags - directly from response
    const hashtags = data.hashtags || [];

    // Extract author info - using correct field names
    const author = {
      username: data.ownerUsername || 'unknown',
      fullName: data.ownerFullName || '',
      profilePic: data.ownerProfilePicUrl || ''
    };

    // Debug logging for image extraction
    console.log('[ApifyInstagram] Image extraction debug:', {
      displayUrl: !!data.displayUrl,
      thumbnailUrl: !!data.thumbnailUrl,
      videoThumbnail: !!data.videoThumbnail,
      imageUrl: !!data.imageUrl,
      coverPhotoUrl: !!data.coverPhotoUrl,
      previewImageUrl: !!data.previewImageUrl,
      imageUrls: Array.isArray(data.imageUrls) ? data.imageUrls.length : 'not array',
      images: Array.isArray(data.images) ? data.images.length : 'not array',
      displayUrls: Array.isArray(data.displayUrls) ? data.displayUrls.length : 'not array',
      extractedImageCount: images.length,
      extractedImageUrl: images[0]?.url ? images[0].url.substring(0, 100) + '...' : 'none'
    });

    console.log('[ApifyInstagram] Parsed data:', {
      hasCaption: !!caption,
      captionLength: caption.length,
      hasVideo: isVideo,
      videoUrl: !!videoUrl,
      videoDuration,
      imageCount: images.length,
      hashtagCount: hashtags.length,
      finalImageUrl: images[0]?.url || 'NO IMAGE EXTRACTED'
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
      likes: data.likesCount || 0,
      comments: data.commentsCount || 0,
      viewCount: data.videoViewCount || data.videoPlayCount || 0,
      timestamp: data.timestamp,
      isVideo: isVideo,
      extractedWithApify: true,
      requiresImmediateProcessing: isVideo // Flag for priority processing
    };
  }

  async checkUsageLimit(userId) {
    try {
      const currentMonth = new Date().toISOString().slice(0, 7); // YYYY-MM format

      // Get or create usage record
      const { data: usageData, error } = await this.supabase
        .from('apify_usage')
        .select('usage_count')
        .eq('user_id', userId)
        .eq('month_year', currentMonth)
        .single();

      if (error && error.code !== 'PGRST116') { // PGRST116 = no rows
        console.error('[ApifyInstagram] Usage check error:', error);
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
      console.error('[ApifyInstagram] Usage limit check error:', error);
      // Allow on error to not block user
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

      // Upsert usage record
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
        // If record existed, increment the count
        await this.supabase.rpc('increment_apify_usage', {
          p_user_id: userId,
          p_month_year: currentMonth
        });
      }

      console.log('[ApifyInstagram] Usage incremented for user:', userId);
    } catch (error) {
      console.error('[ApifyInstagram] Failed to increment usage:', error);
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
        console.error('[ApifyInstagram] Get usage stats error:', error);
      }

      const used = data?.usage_count || 0;
      return {
        used: used,
        limit: this.freeLimit,
        remaining: Math.max(0, this.freeLimit - used),
        percentage: Math.round((used / this.freeLimit) * 100)
      };
    } catch (error) {
      console.error('[ApifyInstagram] Get usage stats error:', error);
      return {
        used: 0,
        limit: this.freeLimit,
        remaining: this.freeLimit,
        percentage: 0
      };
    }
  }

  async checkCache(url) {
    try {
      const { data } = await this.supabase
        .from('instagram_cache')
        .select('data')
        .eq('url', url)
        .eq('extracted_with_apify', true)
        .gt('expires_at', new Date().toISOString())
        .single();

      if (data) {
        console.log('[ApifyInstagram] Cache hit for URL:', url);
        return JSON.parse(data.data);
      }
    } catch (error) {
      // Cache miss is expected, not an error
    }
    return null;
  }

  async cacheResult(url, data) {
    try {
      const expiresAt = new Date();
      expiresAt.setHours(expiresAt.getHours() + 24); // 24 hour cache

      await this.supabase
        .from('instagram_cache')
        .upsert({
          url: url,
          data: JSON.stringify(data),
          extracted_with_apify: true,
          expires_at: expiresAt.toISOString(),
          created_at: new Date().toISOString()
        }, {
          onConflict: 'url'
        });

      console.log('[ApifyInstagram] Result cached for URL:', url);
    } catch (error) {
      console.error('[ApifyInstagram] Cache error:', error);
    }
  }

  /**
   * Download Instagram image and store in Supabase storage with enhanced debugging
   * @param {string} imageUrl - Instagram image URL to download
   * @param {string} recipeId - Recipe ID for filename
   * @param {string} userId - User ID for folder organization
   * @param {object} apifyData - Original Apify response data for debugging
   * @returns {Promise<string|null>} - Supabase public URL or null if failed
   */
  async downloadInstagramImage(imageUrl, recipeId, userId, apifyData = null) {
    if (!imageUrl || !recipeId || !userId) {
      console.error('[ApifyInstagram] downloadInstagramImage: Missing required parameters');
      return null;
    }

    try {
      console.log('[ApifyInstagram] ========== IMAGE DOWNLOAD DEBUG ==========');
      console.log('[ApifyInstagram] Target URL:', imageUrl);
      console.log('[ApifyInstagram] URL type:', this.identifyImageUrlType(imageUrl));
      console.log('[ApifyInstagram] Recipe ID:', recipeId);
      console.log('[ApifyInstagram] User ID:', userId);

      // Enhanced debugging: analyze the URL we're trying to download
      if (apifyData) {
        console.log('[ApifyInstagram] === APIFY DATA DEBUG ===');
        console.log('[ApifyInstagram] displayUrl:', typeof apifyData.displayUrl === 'string' ? apifyData.displayUrl.substring(0, 150) + '...' : apifyData.displayUrl);
        console.log('[ApifyInstagram] images array length:', apifyData.images?.length || 0);
        console.log('[ApifyInstagram] images[0]:', typeof apifyData.images?.[0] === 'string' ? apifyData.images[0].substring(0, 150) + '...' : apifyData.images?.[0]);
        console.log('[ApifyInstagram] videoUrl:', !!apifyData.videoUrl);

        // Look for any Apify proxied URLs in the response
        const responseString = JSON.stringify(apifyData);
        if (responseString.includes('apifyusercontent.com')) {
          console.log('[ApifyInstagram] ⚠️ FOUND APIFY PROXIED URL IN RESPONSE!');
          const apifyMatch = responseString.match(/https:\/\/images\.apifyusercontent\.com\/[^"]+/);
          if (apifyMatch) {
            console.log('[ApifyInstagram] Apify proxied URL found:', apifyMatch[0]);
          }
        } else {
          console.log('[ApifyInstagram] ❌ No Apify proxied URLs found in response');
        }
      }

      // Download image from Instagram with enhanced error handling
      const response = await fetch(imageUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
          'Accept': 'image/webp,image/apng,image/*,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
          'Cache-Control': 'no-cache',
          'Referer': 'https://www.instagram.com/'
        },
        timeout: 30000 // 30 second timeout
      });

      if (!response.ok) {
        console.error('[ApifyInstagram] Failed to download image:', response.status, response.statusText);
        if (response.status === 403) {
          console.error('[ApifyInstagram] Access forbidden - Instagram may be blocking this request');
        } else if (response.status === 404) {
          console.error('[ApifyInstagram] Image not found - URL may have expired');
        } else if (response.status >= 500) {
          console.error('[ApifyInstagram] Server error - Instagram service may be down');
        }
        return null;
      }

      // Check content type
      const contentType = response.headers.get('content-type') || '';
      if (!contentType.startsWith('image/')) {
        console.error('[ApifyInstagram] Response is not an image:', contentType);
        return null;
      }

      // Get image buffer
      const imageBuffer = await response.buffer();

      if (!imageBuffer || imageBuffer.length === 0) {
        console.error('[ApifyInstagram] Downloaded image buffer is empty');
        return null;
      }

      // Check file size (limit to 10MB for safety)
      const maxSizeBytes = 10 * 1024 * 1024; // 10MB
      if (imageBuffer.length > maxSizeBytes) {
        console.error('[ApifyInstagram] Image too large:', imageBuffer.length, 'bytes (max:', maxSizeBytes, ')');
        return null;
      }

      console.log('[ApifyInstagram] Image downloaded successfully:', imageBuffer.length, 'bytes');

      // Determine file extension from Content-Type
      let extension = 'jpg'; // Default
      if (contentType.includes('png')) extension = 'png';
      else if (contentType.includes('webp')) extension = 'webp';
      else if (contentType.includes('gif')) extension = 'gif';

      // Generate unique filename
      const timestamp = Date.now();
      const fileName = `${userId}/${recipeId}-${timestamp}.${extension}`;

      console.log('[ApifyInstagram] Uploading to Supabase storage:', fileName);

      // Upload to Supabase storage
      const { data: uploadData, error: uploadError } = await this.supabase.storage
        .from('recipe-images')
        .upload(fileName, imageBuffer, {
          contentType: contentType || 'image/jpeg',
          cacheControl: '31536000', // 1 year cache
          upsert: false // Don't overwrite if exists
        });

      if (uploadError) {
        console.error('[ApifyInstagram] Supabase upload error:', uploadError);

        // Handle specific Supabase errors
        if (uploadError.message?.includes('The resource already exists')) {
          console.error('[ApifyInstagram] File already exists, trying with different name');
          // Could implement retry logic here if needed
        } else if (uploadError.message?.includes('Payload too large')) {
          console.error('[ApifyInstagram] Image file too large for Supabase storage');
        } else if (uploadError.message?.includes('Invalid JWT')) {
          console.error('[ApifyInstagram] Authentication error with Supabase');
        } else if (uploadError.message?.includes('quota')) {
          console.error('[ApifyInstagram] Storage quota exceeded');
        }

        return null;
      }

      // Get public URL
      const { data: urlData } = this.supabase.storage
        .from('recipe-images')
        .getPublicUrl(fileName);

      if (!urlData || !urlData.publicUrl) {
        console.error('[ApifyInstagram] Failed to get public URL for uploaded image');
        return null;
      }

      // Validate that we got a proper URL
      if (!urlData.publicUrl.startsWith('http')) {
        console.error('[ApifyInstagram] Invalid public URL returned:', urlData.publicUrl);
        return null;
      }

      console.log('[ApifyInstagram] Image successfully uploaded:', urlData.publicUrl);

      return urlData.publicUrl;

    } catch (error) {
      console.error('[ApifyInstagram] Error downloading/uploading image:', error.message);
      console.error('[ApifyInstagram] Error stack:', error.stack);
      console.log('[ApifyInstagram] ========== END IMAGE DOWNLOAD DEBUG ==========');
      return null;
    }
  }

  /**
   * Identify the type of image URL for debugging
   * @param {string} url - Image URL to analyze
   * @returns {string} - URL type description
   */
  identifyImageUrlType(url) {
    if (!url) return 'INVALID';

    if (url.includes('apifyusercontent.com')) {
      return 'APIFY_PROXIED';
    } else if (url.includes('scontent') && url.includes('cdninstagram.com')) {
      return 'INSTAGRAM_SCONTENT';
    } else if (url.includes('instagram.com')) {
      return 'INSTAGRAM_DIRECT';
    } else if (url.includes('images.unsplash.com')) {
      return 'PLACEHOLDER';
    } else {
      return 'UNKNOWN';
    }
  }

  /**
   * Try to construct Apify proxied URL from Instagram URL
   * @param {string} instagramUrl - Original Instagram URL
   * @param {string} datasetId - Apify dataset ID (if available)
   * @returns {string|null} - Constructed Apify proxy URL or null
   */
  constructApifyProxyUrl(instagramUrl, datasetId = null) {
    if (!instagramUrl || !instagramUrl.startsWith('http')) {
      return null;
    }

    try {
      // If we have a dataset ID, try to construct the proxy URL
      if (datasetId) {
        const base64Url = Buffer.from(instagramUrl).toString('base64');
        const proxyUrl = `https://images.apifyusercontent.com/${datasetId}/cb:1/${base64Url}.jpg`;
        console.log('[ApifyInstagram] Constructed proxy URL:', proxyUrl);
        return proxyUrl;
      }

      // If no dataset ID, can't construct proxy URL
      console.log('[ApifyInstagram] Cannot construct proxy URL - no dataset ID');
      return null;
    } catch (error) {
      console.error('[ApifyInstagram] Error constructing proxy URL:', error.message);
      return null;
    }
  }
}

module.exports = ApifyInstagramService;