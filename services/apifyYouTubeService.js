const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');
const fetch = require('node-fetch'); // For downloading images

class ApifyYouTubeService {
  constructor() {
    this.apiToken = process.env.APIFY_API_TOKEN;
    this.actorId = process.env.APIFY_YOUTUBE_ACTOR || 'streamers/youtube-scraper';
    this.transcriptActorId = process.env.APIFY_YOUTUBE_TRANSCRIPT_ACTOR || 'topaz_sharingan/youtube-transcript-scraper';
    this.freeLimit = parseInt(process.env.APIFY_FREE_TIER_LIMIT) || 50; // SHARED with Instagram/Facebook
    this.timeoutSeconds = parseInt(process.env.APIFY_TIMEOUT_SECONDS) || 45; // Longer timeout for YouTube
    this.maxDurationSeconds = 1800; // 30 minutes maximum

    this.supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_ANON_KEY
    );
  }

  /**
   * Normalize YouTube URL to standard format
   * Supports: youtube.com/watch?v=, youtu.be/, youtube.com/shorts/, m.youtube.com
   * @param {string} url - YouTube URL
   * @returns {string} - Normalized URL (youtube.com/watch?v=VIDEO_ID)
   */
  normalizeYouTubeUrl(url) {
    try {
      const patterns = [
        /(?:youtube\.com\/watch\?v=)([^&]+)/, // youtube.com/watch?v=VIDEO_ID
        /(?:youtu\.be\/)([^?]+)/, // youtu.be/VIDEO_ID
        /(?:youtube\.com\/shorts\/)([^?]+)/, // youtube.com/shorts/VIDEO_ID
        /(?:m\.youtube\.com\/watch\?v=)([^&]+)/ // m.youtube.com/watch?v=VIDEO_ID
      ];

      for (const pattern of patterns) {
        const match = url.match(pattern);
        if (match && match[1]) {
          const videoId = match[1];
          console.log(`[ApifyYouTube] Normalized URL with video ID: ${videoId}`);
          return `https://www.youtube.com/watch?v=${videoId}`;
        }
      }

      // If no pattern matches, might already be in standard format
      if (url.includes('youtube.com/watch?v=')) {
        return url;
      }

      throw new Error('Could not extract video ID from URL');
    } catch (error) {
      console.error('[ApifyYouTube] URL normalization error:', error.message);
      throw new Error('Invalid YouTube URL format');
    }
  }

  /**
   * Extract video ID from YouTube URL
   * @param {string} url - YouTube URL
   * @returns {string|null} - Video ID or null
   */
  extractVideoId(url) {
    try {
      const normalized = this.normalizeYouTubeUrl(url);
      const match = normalized.match(/[?&]v=([^&]+)/);
      return match ? match[1] : null;
    } catch (error) {
      console.error('[ApifyYouTube] Video ID extraction error:', error.message);
      return null;
    }
  }

  /**
   * Validate YouTube URL
   * @param {string} url - URL to validate
   * @returns {boolean} - True if valid YouTube URL
   */
  validateYouTubeUrl(url) {
    if (!url || typeof url !== 'string') return false;

    try {
      this.normalizeYouTubeUrl(url);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Parse ISO 8601 duration (PT15M33S) to seconds
   * @param {string} isoDuration - ISO 8601 duration string
   * @returns {number} - Duration in seconds
   */
  parseDuration(isoDuration) {
    if (!isoDuration || typeof isoDuration !== 'string') return 0;

    try {
      const match = isoDuration.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
      if (!match) return 0;

      const hours = parseInt(match[1] || 0);
      const minutes = parseInt(match[2] || 0);
      const seconds = parseInt(match[3] || 0);

      return hours * 3600 + minutes * 60 + seconds;
    } catch (error) {
      console.error('[ApifyYouTube] Duration parsing error:', error.message);
      return 0;
    }
  }

  /**
   * Detect if video is a YouTube Short
   * @param {string} url - YouTube URL
   * @param {number} duration - Video duration in seconds
   * @returns {boolean} - True if video is a Short
   */
  isYouTubeShort(url, duration) {
    // Check URL pattern for /shorts/
    const hasShortUrl = url && url.includes('/shorts/');

    // Check duration (Shorts are typically under 60 seconds)
    const hasShortDuration = duration && duration < 60;

    return hasShortUrl || hasShortDuration;
  }

  /**
   * Select best thumbnail from available options
   * Priority: maxresdefault > sddefault > hqdefault > default
   * @param {array} thumbnails - Array of thumbnail objects
   * @returns {string|null} - Best thumbnail URL
   */
  selectBestThumbnail(thumbnails) {
    if (!Array.isArray(thumbnails) || thumbnails.length === 0) {
      return null;
    }

    const priority = ['maxresdefault', 'sddefault', 'hqdefault', 'default'];

    for (const quality of priority) {
      const thumbnail = thumbnails.find(t => t.url && t.url.includes(quality));
      if (thumbnail) {
        console.log(`[ApifyYouTube] Selected ${quality} thumbnail`);
        return thumbnail.url;
      }
    }

    // Fallback to first available thumbnail
    const fallback = thumbnails[0]?.url || null;
    if (fallback) {
      console.log('[ApifyYouTube] Using fallback thumbnail (first available)');
    }
    return fallback;
  }

  /**
   * Extract video transcript using Apify actor
   * @param {string} videoId - YouTube video ID
   * @returns {Promise<string|null>} - Transcript text or null
   */
  async extractTranscript(videoId) {
    if (!videoId) {
      console.error('[ApifyYouTube] Cannot extract transcript - no video ID provided');
      return null;
    }

    try {
      console.log(`[ApifyYouTube] Starting transcript extraction for video: ${videoId}`);

      // Start transcript actor
      const response = await axios.post(
        `https://api.apify.com/v2/acts/${this.transcriptActorId}/runs`,
        {
          videoId: videoId
        },
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

      const runId = response.data.data.id;
      console.log(`[ApifyYouTube] Transcript actor started, run ID: ${runId}`);

      // Poll for transcript results
      const transcriptData = await this.pollForResults(runId, 20); // Shorter polling for transcripts

      if (transcriptData.success && transcriptData.data) {
        const transcript = transcriptData.data.transcript || transcriptData.data.text || null;

        if (transcript) {
          console.log(`[ApifyYouTube] Transcript extracted successfully (${transcript.length} chars)`);
          return transcript;
        }
      }

      console.warn('[ApifyYouTube] No transcript found for video');
      return null;

    } catch (error) {
      console.error('[ApifyYouTube] Transcript extraction error:', error.message);
      // Don't fail the whole extraction if transcript fails
      return null;
    }
  }

  /**
   * Main extraction method
   * @param {string} youtubeUrl - YouTube video URL
   * @param {string} userId - User ID for usage tracking
   * @returns {Promise<object>} - Extraction result
   */
  async extractFromUrl(youtubeUrl, userId) {
    console.log('[ApifyYouTube] Starting extraction for:', youtubeUrl);
    console.log('[ApifyYouTube] User ID:', userId);

    try {
      // Validate and normalize URL
      if (!this.validateYouTubeUrl(youtubeUrl)) {
        return {
          success: false,
          error: 'Invalid YouTube URL. Please provide a valid YouTube video link.'
        };
      }

      const normalizedUrl = this.normalizeYouTubeUrl(youtubeUrl);
      console.log('[ApifyYouTube] Normalized URL:', normalizedUrl);

      // Check usage limits first
      const canUse = await this.checkUsageLimit(userId);
      if (!canUse.allowed) {
        console.log('[ApifyYouTube] Usage limit exceeded:', canUse);
        return {
          success: false,
          error: 'Monthly limit reached for premium imports (shared across Instagram, Facebook, and YouTube)',
          limitExceeded: true,
          usage: canUse.usage
        };
      }

      // Check cache
      const cached = await this.checkCache(normalizedUrl);
      if (cached) {
        console.log('[ApifyYouTube] Found cached result');
        return cached;
      }

      // Start Apify actor run
      console.log('[ApifyYouTube] Starting Apify actor...');
      const runResponse = await this.startActorRun(normalizedUrl);

      if (!runResponse.success) {
        console.error('[ApifyYouTube] Failed to start actor:', runResponse.error);
        return runResponse;
      }

      // Poll for results
      console.log('[ApifyYouTube] Polling for results, run ID:', runResponse.runId);
      const results = await this.pollForResults(runResponse.runId);

      if (!results.success) {
        console.error('[ApifyYouTube] Failed to get results:', results.error);
        return results;
      }

      // Parse and enhance results
      const parsedData = await this.parseApifyResponse(results.data, normalizedUrl);

      if (!parsedData.success) {
        return parsedData;
      }

      // Increment usage
      await this.incrementUsage(userId);

      // Cache the result
      await this.cacheResult(normalizedUrl, parsedData);

      console.log('[ApifyYouTube] Extraction successful:', {
        hasDescription: !!parsedData.caption,
        hasTranscript: !!parsedData.transcript,
        imageCount: parsedData.images?.length || 0,
        duration: parsedData.videoDuration,
        isShort: parsedData.isShort
      });

      return parsedData;

    } catch (error) {
      console.error('[ApifyYouTube] Extraction error:', error);
      return {
        success: false,
        error: error.message || 'Failed to extract from YouTube'
      };
    }
  }

  /**
   * Start Apify actor run
   * @param {string} youtubeUrl - Normalized YouTube URL
   * @returns {Promise<object>} - Run response with runId
   */
  async startActorRun(youtubeUrl) {
    try {
      const inputData = {
        startUrls: [{ url: youtubeUrl }],
        maxResults: 1
      };

      console.log('[ApifyYouTube] Sending input to actor:', inputData);

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
      console.error('[ApifyYouTube] Actor start error:', error.response?.data || error.message);
      return {
        success: false,
        error: error.response?.data?.error?.message || error.message
      };
    }
  }

  /**
   * Poll Apify actor for results
   * @param {string} runId - Apify run ID
   * @param {number} maxAttempts - Maximum polling attempts
   * @returns {Promise<object>} - Results or error
   */
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
        console.log(`[ApifyYouTube] Run status: ${status} (attempt ${attempts + 1}/${maxAttempts})`);

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
          // Special handling for timeout
          if (status === 'TIMED-OUT') {
            return {
              success: false,
              error: 'YouTube extraction is taking longer than usual. Please try again in a moment or try a different video.',
              isTimeout: true,
              technicalError: `Actor run timed-out after ${this.timeoutSeconds} seconds`
            };
          }

          return {
            success: false,
            error: `Actor run ${status.toLowerCase()}`
          };
        }

        // Wait before next poll
        await new Promise(resolve => setTimeout(resolve, pollInterval));
        attempts++;

      } catch (error) {
        console.error('[ApifyYouTube] Polling error:', error.message);
        return {
          success: false,
          error: error.message
        };
      }
    }

    return {
      success: false,
      error: 'YouTube extraction is taking longer than usual. Please try again in a moment or try a different video.',
      isTimeout: true,
      technicalError: 'Polling timeout - actor still running after maximum attempts'
    };
  }

  /**
   * Parse Apify response and extract YouTube data
   * @param {object} data - Raw Apify response data
   * @param {string} originalUrl - Original YouTube URL
   * @returns {Promise<object>} - Parsed data
   */
  async parseApifyResponse(data, originalUrl) {
    console.log('[ApifyYouTube] Parsing response data...');

    if (!data) {
      return {
        success: false,
        error: 'No data received from Apify'
      };
    }

    try {
      // Extract video duration and check limit
      const isoDuration = data.duration || data.videoDuration || 'PT0S';
      const videoDuration = this.parseDuration(isoDuration);

      console.log('[ApifyYouTube] Video duration:', videoDuration, 'seconds');

      // Check duration limit (30 minutes)
      if (videoDuration > this.maxDurationSeconds) {
        return {
          success: false,
          error: `Video too long. Maximum duration: ${Math.floor(this.maxDurationSeconds / 60)} minutes`,
          durationExceeded: true,
          actualDuration: Math.round(videoDuration / 60) // Return duration in minutes
        };
      }

      // Detect if this is a Short
      const isShort = this.isYouTubeShort(originalUrl, videoDuration);
      console.log('[ApifyYouTube] Is YouTube Short:', isShort);

      // Extract description
      let description = data.description || '';
      console.log('[ApifyYouTube] Description length:', description.length, 'chars');

      // Determine if we need transcript extraction
      // Shorts: ALWAYS extract transcript
      // Regular videos: Extract when description is insufficient
      const needsTranscript = (
        isShort || // YouTube Shorts always get transcripts
        description.length < 200 ||
        description.toLowerCase().includes('recipe in video') ||
        !description
      ) && videoDuration < this.maxDurationSeconds;

      console.log('[ApifyYouTube] Needs transcript:', needsTranscript, {
        isShort,
        descriptionLength: description.length,
        hasRecipeInVideoText: description.toLowerCase().includes('recipe in video')
      });

      // Extract transcript if needed
      let transcript = null;
      if (needsTranscript) {
        const videoId = this.extractVideoId(originalUrl);
        if (videoId) {
          console.log('[ApifyYouTube] Extracting transcript...');
          transcript = await this.extractTranscript(videoId);

          if (transcript) {
            // Combine description and transcript
            description = description
              ? `${description}\n\n===== VIDEO TRANSCRIPT =====\n${transcript}`
              : transcript;
            console.log('[ApifyYouTube] Combined description + transcript:', description.length, 'chars');
          }
        }
      }

      // Extract thumbnails
      const thumbnails = data.thumbnails || [];
      const bestThumbnailUrl = this.selectBestThumbnail(thumbnails);

      const images = bestThumbnailUrl ? [{
        url: bestThumbnailUrl,
        isApifyProxy: false // YouTube thumbnails are permanent CDN URLs
      }] : [];

      console.log('[ApifyYouTube] Thumbnail extracted:', !!bestThumbnailUrl);

      // Extract author/channel info
      const author = {
        username: data.channelName || data.channelTitle || data.author || 'unknown',
        fullName: data.channelName || data.channelTitle || '',
        profilePic: data.channelThumbnail || data.channelImage || ''
      };

      // Extract hashtags/tags
      const hashtags = data.tags || data.hashtags || [];

      // Extract engagement metrics
      const likes = data.likesCount || data.likes || 0;
      const comments = data.commentsCount || data.numberOfComments || 0;
      const viewCount = data.viewCount || data.views || 0;

      console.log('[ApifyYouTube] Parsed data summary:', {
        descriptionLength: description.length,
        hasTranscript: !!transcript,
        transcriptLength: transcript?.length || 0,
        imageCount: images.length,
        videoDuration,
        author: author.username,
        likes,
        views: viewCount,
        isShort
      });

      return {
        success: true,
        caption: description, // Combined description + transcript
        images: images,
        videoUrl: originalUrl, // Reference only (not downloadable)
        videoDuration: videoDuration,
        videoUrlExpiry: null, // YouTube URLs don't expire
        extractionTimestamp: Date.now(),
        author: author,
        hashtags: hashtags,
        likes: likes,
        comments: comments,
        viewCount: viewCount,
        timestamp: data.publishedAt || data.uploadDate || new Date().toISOString(),
        isVideo: true,
        platform: 'youtube',
        extractedWithApify: true,
        requiresImmediateProcessing: false, // Description is primary source
        transcript: transcript, // Store transcript separately for reference
        isShort: isShort,
        channelUrl: data.channelUrl || `https://www.youtube.com/channel/${data.channelId || ''}`,
        channelSubscribers: data.subscriberCount || data.subscribersCount || 0,
        durationExceeded: false
      };

    } catch (error) {
      console.error('[ApifyYouTube] Parse error:', error);
      return {
        success: false,
        error: 'Failed to parse YouTube data: ' + error.message
      };
    }
  }

  /**
   * Check usage limit (SHARED with Instagram/Facebook)
   * @param {string} userId - User ID
   * @returns {Promise<object>} - Usage status
   */
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
        console.error('[ApifyYouTube] Usage check error:', error);
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
      console.error('[ApifyYouTube] Usage limit check error:', error);
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

  /**
   * Increment usage counter (SHARED with Instagram/Facebook)
   * @param {string} userId - User ID
   */
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

      console.log('[ApifyYouTube] Usage incremented for user:', userId);
    } catch (error) {
      console.error('[ApifyYouTube] Failed to increment usage:', error);
    }
  }

  /**
   * Get usage statistics (SHARED with Instagram/Facebook)
   * @param {string} userId - User ID
   * @returns {Promise<object>} - Usage stats
   */
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
        console.error('[ApifyYouTube] Get usage stats error:', error);
      }

      const used = data?.usage_count || 0;
      return {
        used: used,
        limit: this.freeLimit,
        remaining: Math.max(0, this.freeLimit - used),
        percentage: Math.round((used / this.freeLimit) * 100)
      };
    } catch (error) {
      console.error('[ApifyYouTube] Get usage stats error:', error);
      return {
        used: 0,
        limit: this.freeLimit,
        remaining: this.freeLimit,
        percentage: 0
      };
    }
  }

  /**
   * Check cache for YouTube URL
   * @param {string} url - Normalized YouTube URL
   * @returns {Promise<object|null>} - Cached data or null
   */
  async checkCache(url) {
    try {
      const { data } = await this.supabase
        .from('youtube_cache')
        .select('data')
        .eq('url', url)
        .eq('extracted_with_apify', true)
        .gt('expires_at', new Date().toISOString())
        .single();

      if (data) {
        console.log('[ApifyYouTube] Cache hit for URL:', url);
        return JSON.parse(data.data);
      }
    } catch (error) {
      // Cache miss is expected, not an error
    }
    return null;
  }

  /**
   * Cache extraction result
   * @param {string} url - Normalized YouTube URL
   * @param {object} data - Extraction result to cache
   */
  async cacheResult(url, data) {
    try {
      const expiresAt = new Date();
      expiresAt.setHours(expiresAt.getHours() + 24); // 24 hour cache

      await this.supabase
        .from('youtube_cache')
        .upsert({
          url: url,
          data: JSON.stringify(data),
          extracted_with_apify: true,
          expires_at: expiresAt.toISOString(),
          created_at: new Date().toISOString()
        }, {
          onConflict: 'url'
        });

      console.log('[ApifyYouTube] Result cached for URL:', url);
    } catch (error) {
      console.error('[ApifyYouTube] Cache error:', error);
    }
  }

  /**
   * Download YouTube thumbnail and store in Supabase storage
   * @param {string} thumbnailUrl - YouTube thumbnail URL
   * @param {string} recipeId - Recipe ID for filename
   * @param {string} userId - User ID for folder organization
   * @returns {Promise<string|null>} - Supabase public URL or null if failed
   */
  async downloadYouTubeThumbnail(thumbnailUrl, recipeId, userId) {
    if (!thumbnailUrl || !recipeId || !userId) {
      console.error('[ApifyYouTube] downloadYouTubeThumbnail: Missing required parameters');
      return null;
    }

    try {
      console.log('[ApifyYouTube] ========== THUMBNAIL DOWNLOAD ==========');
      console.log('[ApifyYouTube] Target URL:', thumbnailUrl);
      console.log('[ApifyYouTube] Recipe ID:', recipeId);
      console.log('[ApifyYouTube] User ID:', userId);

      // Download thumbnail
      const response = await fetch(thumbnailUrl, {
        timeout: 30000, // 30 second timeout
        headers: {
          'Accept': 'image/*,*/*;q=0.8',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
      });

      if (!response.ok) {
        console.error('[ApifyYouTube] Failed to download thumbnail:', response.status, response.statusText);
        return null;
      }

      // Check content type
      const contentType = response.headers.get('content-type') || '';
      if (!contentType.startsWith('image/')) {
        console.error('[ApifyYouTube] Response is not an image:', contentType);
        return null;
      }

      // Get image buffer
      const imageBuffer = await response.buffer();

      if (!imageBuffer || imageBuffer.length === 0) {
        console.error('[ApifyYouTube] Downloaded thumbnail buffer is empty');
        return null;
      }

      // Check file size (limit to 10MB for safety)
      const maxSizeBytes = 10 * 1024 * 1024; // 10MB
      if (imageBuffer.length > maxSizeBytes) {
        console.error('[ApifyYouTube] Thumbnail too large:', imageBuffer.length, 'bytes');
        return null;
      }

      console.log('[ApifyYouTube] Thumbnail downloaded successfully:', imageBuffer.length, 'bytes');

      // Determine file extension from Content-Type
      let extension = 'jpg'; // Default
      if (contentType.includes('png')) extension = 'png';
      else if (contentType.includes('webp')) extension = 'webp';

      // Generate unique filename
      const timestamp = Date.now();
      const fileName = `${userId}/${recipeId}-${timestamp}.${extension}`;

      console.log('[ApifyYouTube] Uploading to Supabase storage:', fileName);

      // Upload to Supabase storage
      const { data: uploadData, error: uploadError } = await this.supabase.storage
        .from('recipe-images')
        .upload(fileName, imageBuffer, {
          contentType: contentType || 'image/jpeg',
          cacheControl: '31536000', // 1 year cache
          upsert: false // Don't overwrite if exists
        });

      if (uploadError) {
        console.error('[ApifyYouTube] Supabase upload error:', uploadError);
        return null;
      }

      // Get public URL
      const { data: urlData } = this.supabase.storage
        .from('recipe-images')
        .getPublicUrl(fileName);

      if (!urlData || !urlData.publicUrl) {
        console.error('[ApifyYouTube] Failed to get public URL');
        return null;
      }

      console.log('[ApifyYouTube] Thumbnail uploaded successfully:', urlData.publicUrl);
      console.log('[ApifyYouTube] ========== END THUMBNAIL DOWNLOAD ==========');

      return urlData.publicUrl;

    } catch (error) {
      console.error('[ApifyYouTube] Thumbnail download error:', error);
      return null;
    }
  }
}

// Export singleton instance
module.exports = new ApifyYouTubeService();
