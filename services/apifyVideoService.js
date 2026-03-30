const axios = require('axios');
const fs = require('fs').promises;
const path = require('path');
const os = require('os');

/**
 * Apify Video Service - Downloads YouTube videos using Apify actor
 * Bypasses YouTube bot detection by using professional anti-blocking infrastructure
 *
 * Actor: streamers/youtube-video-downloader
 * Cost: ~$0.01 per run + $0.002 per 10MB
 */
class ApifyVideoService {
  constructor() {
    this.apiToken = process.env.APIFY_API_TOKEN;
    // Try different actor IDs in order of preference
    this.actorId = 'logiover/youtube-video-downloader';  // 4K/8K MP4 downloader
    this.baseUrl = 'https://api.apify.com/v2';

    if (!this.apiToken) {
      console.warn('[ApifyVideo] WARNING: APIFY_API_TOKEN not configured');
    } else {
      console.log('[ApifyVideo] Service initialized with actor:', this.actorId);
    }
  }

  /**
   * Download YouTube video using Apify actor
   * @param {string} youtubeUrl - YouTube URL to download
   * @returns {Promise<object>} { videoPath, fileSize, cost }
   */
  async downloadVideo(youtubeUrl) {
    console.log('[ApifyVideo] Starting video download for:', youtubeUrl);

    if (!this.apiToken) {
      throw new Error('APIFY_API_TOKEN environment variable not set');
    }

    try {
      // 1. Start Apify actor run
      const runId = await this.startActorRun(youtubeUrl);
      console.log('[ApifyVideo] Actor run started:', runId);

      // 2. Wait for completion (max 2 minutes)
      const result = await this.waitForCompletion(runId);
      console.log('[ApifyVideo] Actor completed, fetching video file');

      // 3. Download video from Apify storage
      const videoPath = await this.downloadFromStorage(result.videoUrl);
      const stats = await fs.stat(videoPath);
      const fileSizeMB = (stats.size / 1024 / 1024).toFixed(2);

      // 4. Calculate cost
      const cost = this.calculateCost(parseFloat(fileSizeMB));

      console.log('[ApifyVideo] ✓ Download complete:', {
        path: videoPath,
        size: `${fileSizeMB} MB`,
        cost: `$${cost.toFixed(4)}`
      });

      return {
        videoPath,
        fileSize: stats.size,
        cost
      };

    } catch (error) {
      console.error('[ApifyVideo] Download failed:', error.message);
      throw new Error(`Apify video download failed: ${error.message}`);
    }
  }

  /**
   * Start Apify actor run with YouTube URL
   * @private
   */
  async startActorRun(youtubeUrl) {
    const response = await axios.post(
      `${this.baseUrl}/acts/${this.actorId}/runs`,
      {
        url: youtubeUrl,
        quality: '720p',  // Balance between quality and cost
        format: 'mp4'
      },
      {
        headers: { 'Authorization': `Bearer ${this.apiToken}` },
        timeout: 30000  // 30 second timeout for API call
      }
    );

    if (!response.data?.data?.id) {
      throw new Error('Invalid response from Apify API - no run ID');
    }

    return response.data.data.id;
  }

  /**
   * Poll Apify actor run until completion
   * @private
   */
  async waitForCompletion(runId, maxWaitMs = 120000) {
    const startTime = Date.now();
    const pollInterval = 5000; // 5 seconds
    let attempts = 0;

    while (Date.now() - startTime < maxWaitMs) {
      attempts++;

      try {
        const response = await axios.get(
          `${this.baseUrl}/actor-runs/${runId}`,
          {
            headers: { 'Authorization': `Bearer ${this.apiToken}` },
            timeout: 10000
          }
        );

        const status = response.data.data.status;
        console.log(`[ApifyVideo] Run status: ${status} (attempt ${attempts})`);

        if (status === 'SUCCEEDED') {
          // Get dataset items (video URL)
          const datasetId = response.data.data.defaultDatasetId;

          if (!datasetId) {
            throw new Error('No dataset ID in successful run');
          }

          const items = await axios.get(
            `${this.baseUrl}/datasets/${datasetId}/items`,
            {
              headers: { 'Authorization': `Bearer ${this.apiToken}` },
              timeout: 10000
            }
          );

          if (items.data && items.data[0]?.videoUrl) {
            return { videoUrl: items.data[0].videoUrl };
          }

          throw new Error('No video URL in dataset result');
        }

        if (status === 'FAILED') {
          throw new Error('Actor run failed - check Apify console for details');
        }

        if (status === 'ABORTED') {
          throw new Error('Actor run was aborted');
        }

        // Wait before next poll
        await new Promise(resolve => setTimeout(resolve, pollInterval));

      } catch (error) {
        // If it's an axios error from the poll, retry
        if (error.isAxiosError && Date.now() - startTime < maxWaitMs) {
          console.warn('[ApifyVideo] Polling error, retrying:', error.message);
          await new Promise(resolve => setTimeout(resolve, pollInterval));
          continue;
        }
        throw error;
      }
    }

    throw new Error(`Actor run timeout after ${maxWaitMs/1000} seconds`);
  }

  /**
   * Download video file from Apify storage to temp directory
   * @private
   */
  async downloadFromStorage(storageUrl) {
    const videoPath = path.join(os.tmpdir(), `apify_video_${Date.now()}.mp4`);

    console.log('[ApifyVideo] Downloading from storage:', storageUrl.substring(0, 60) + '...');

    const response = await axios.get(storageUrl, {
      responseType: 'arraybuffer',
      timeout: 60000,  // 60 second timeout for video download
      maxContentLength: 100 * 1024 * 1024  // 100MB max file size
    });

    await fs.writeFile(videoPath, response.data);

    console.log('[ApifyVideo] Video saved to:', videoPath);

    return videoPath;
  }

  /**
   * Calculate cost of Apify video download
   * @private
   */
  calculateCost(fileSizeMB) {
    // Apify pricing model:
    // - Fixed: $0.01 per actor run
    // - Variable: $0.002 per 10MB of data
    const runCost = 0.01;
    const dataCost = (fileSizeMB / 10) * 0.002;
    return runCost + dataCost;
  }
}

module.exports = new ApifyVideoService();
