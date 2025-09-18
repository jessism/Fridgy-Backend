const fetch = require('node-fetch');
const fs = require('fs').promises;
const path = require('path');
const os = require('os');

// Optional ffmpeg dependencies (frame extraction won't work without them)
let ffmpeg = null;
let ffmpegPath = null;

try {
  ffmpeg = require('fluent-ffmpeg');
  ffmpegPath = require('ffmpeg-static');
  if (ffmpegPath) {
    ffmpeg.setFfmpegPath(ffmpegPath);
  }
  console.log('[VideoProcessor] FFmpeg loaded successfully');
} catch (error) {
  console.warn('[VideoProcessor] FFmpeg not available - frame extraction disabled');
  console.warn('[VideoProcessor] Run "npm install fluent-ffmpeg ffmpeg-static" to enable');
}

class VideoProcessor {
  constructor() {
    this.tempDir = os.tmpdir();
    this.maxFrames = 10; // Maximum frames to extract
    this.frameInterval = 3; // Extract frame every 3 seconds by default
    this.ffmpegAvailable = !!ffmpeg;
  }

  /**
   * Extract key frames from Instagram video URL
   * @param {string} videoUrl - Instagram video URL
   * @param {number} duration - Video duration in seconds
   * @param {object} options - Processing options
   * @returns {Promise<Array>} - Array of frame data with timestamps
   */
  async extractFramesFromVideo(videoUrl, duration, options = {}) {
    if (!this.ffmpegAvailable) {
      console.warn('[VideoProcessor] Frame extraction unavailable - ffmpeg not installed');
      return {
        frames: [],
        audioTranscript: null,
        metadata: {
          duration,
          frameCount: 0,
          framePoints: [],
          error: 'ffmpeg not available'
        }
      };
    }

    const {
      maxFrames = this.maxFrames,
      smartSampling = true,
      extractAudio = false
    } = options;

    console.log('[VideoProcessor] Starting frame extraction:', {
      videoUrl: videoUrl.substring(0, 100) + '...',
      duration,
      maxFrames,
      smartSampling
    });

    try {
      // Calculate optimal frame extraction points
      const framePoints = this.calculateFramePoints(duration, maxFrames, smartSampling);

      console.log('[VideoProcessor] Frame extraction points:', framePoints);

      // Create temporary directory for frames
      const tempVideoDir = path.join(this.tempDir, `video_${Date.now()}`);
      await fs.mkdir(tempVideoDir, { recursive: true });

      // Download video to temp file (required for ffmpeg)
      const videoPath = path.join(tempVideoDir, 'video.mp4');
      await this.downloadVideo(videoUrl, videoPath);

      // Extract frames at calculated points
      const frames = [];
      for (const timestamp of framePoints) {
        const framePath = path.join(tempVideoDir, `frame_${timestamp}.jpg`);

        try {
          await this.extractSingleFrame(videoPath, framePath, timestamp);

          // Read frame as base64
          const frameBuffer = await fs.readFile(framePath);
          const frameBase64 = frameBuffer.toString('base64');

          frames.push({
            timestamp,
            base64: `data:image/jpeg;base64,${frameBase64}`,
            context: this.getFrameContext(timestamp, duration)
          });

          console.log(`[VideoProcessor] Extracted frame at ${timestamp}s`);
        } catch (error) {
          console.error(`[VideoProcessor] Failed to extract frame at ${timestamp}s:`, error.message);
        }
      }

      // Extract audio if requested
      let audioTranscript = null;
      if (extractAudio) {
        audioTranscript = await this.extractAudioTranscript(videoPath);
      }

      // Cleanup temp files
      await this.cleanup(tempVideoDir);

      console.log(`[VideoProcessor] Successfully extracted ${frames.length} frames`);

      return {
        frames,
        audioTranscript,
        metadata: {
          duration,
          frameCount: frames.length,
          framePoints
        }
      };

    } catch (error) {
      console.error('[VideoProcessor] Frame extraction failed:', error);
      throw error;
    }
  }

  /**
   * Calculate optimal frame extraction points based on video content
   * @param {number} duration - Video duration in seconds
   * @param {number} maxFrames - Maximum frames to extract
   * @param {boolean} smartSampling - Use smart sampling for key moments
   * @returns {Array<number>} - Array of timestamps to extract
   */
  calculateFramePoints(duration, maxFrames, smartSampling) {
    const points = [];

    if (smartSampling) {
      // Smart sampling: Focus on key recipe moments

      // Always get first frame (ingredient display)
      points.push(1);

      // Early frames (10-20% - prep work)
      const earlyPoint = Math.floor(duration * 0.15);
      if (earlyPoint > 2) points.push(earlyPoint);

      // Mid-cooking frames (30-70% - main cooking)
      const midInterval = Math.floor(duration * 0.4 / 3); // 3 frames in middle section
      for (let i = 1; i <= 3; i++) {
        const midPoint = Math.floor(duration * 0.3 + midInterval * i);
        if (midPoint < duration - 2) points.push(midPoint);
      }

      // Late frames (80-90% - finishing touches)
      const latePoint = Math.floor(duration * 0.85);
      if (latePoint < duration - 2) points.push(latePoint);

      // Always get last meaningful frame (final dish)
      points.push(Math.max(1, duration - 2));

    } else {
      // Regular interval sampling
      const interval = Math.floor(duration / maxFrames);
      for (let i = 0; i < maxFrames && i * interval < duration; i++) {
        points.push(Math.min(i * interval, duration - 1));
      }
    }

    // Remove duplicates and sort
    return [...new Set(points)].sort((a, b) => a - b).slice(0, maxFrames);
  }

  /**
   * Get smart frame points for optimal 6-frame coverage (for multi-modal extraction)
   * @param {number} duration - Video duration in seconds
   * @returns {Array<number>} - Array of 6 optimal timestamps
   */
  getSmartFramePoints(duration) {
    // 6 optimal frames for comprehensive coverage
    const frames = [];

    // Critical recipe moments
    frames.push(Math.min(3, duration * 0.05));  // Opening (ingredients display)
    frames.push(duration * 0.20);               // Preparation phase (20%)
    frames.push(duration * 0.40);               // Early cooking (40%)
    frames.push(duration * 0.60);               // Main cooking process (60%)
    frames.push(duration * 0.80);               // Assembly/plating (80%)
    frames.push(Math.max(duration * 0.95, duration - 2)); // Final dish (95%)

    // Round to nearest second and ensure within bounds
    return frames.map(t => Math.max(1, Math.min(Math.round(t), duration - 1)));
  }

  /**
   * Get context description for frame based on timestamp
   * @param {number} timestamp - Frame timestamp
   * @param {number} duration - Total video duration
   * @returns {string} - Context description
   */
  getFrameContext(timestamp, duration) {
    const percentage = (timestamp / duration) * 100;

    if (percentage <= 10) {
      return 'ingredient_display';
    } else if (percentage <= 25) {
      return 'preparation';
    } else if (percentage <= 75) {
      return 'cooking_process';
    } else if (percentage <= 90) {
      return 'finishing_touches';
    } else {
      return 'final_presentation';
    }
  }

  /**
   * Download video from URL to local file
   * @param {string} videoUrl - Video URL
   * @param {string} outputPath - Local file path
   */
  async downloadVideo(videoUrl, outputPath) {
    console.log('[VideoProcessor] Downloading video...');

    const response = await fetch(videoUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; Recipe Extractor)',
        'Referer': 'https://www.instagram.com/'
      }
    });

    if (!response.ok) {
      throw new Error(`Failed to download video: ${response.status}`);
    }

    const buffer = await response.buffer();
    await fs.writeFile(outputPath, buffer);

    console.log('[VideoProcessor] Video downloaded successfully');
  }

  /**
   * Extract single frame from video at specific timestamp
   * @param {string} videoPath - Local video file path
   * @param {string} outputPath - Frame output path
   * @param {number} timestamp - Timestamp in seconds
   */
  extractSingleFrame(videoPath, outputPath, timestamp) {
    return new Promise((resolve, reject) => {
      ffmpeg(videoPath)
        .screenshots({
          timestamps: [timestamp],
          filename: path.basename(outputPath),
          folder: path.dirname(outputPath),
          size: '640x?'  // Maintain aspect ratio with width of 640px
        })
        .on('end', resolve)
        .on('error', reject);
    });
  }

  /**
   * Extract audio and attempt basic transcription (placeholder)
   * @param {string} videoPath - Local video file path
   * @returns {Promise<string|null>} - Audio transcript or null
   */
  async extractAudioTranscript(videoPath) {
    // This is a placeholder for audio extraction
    // In production, you would integrate with a speech-to-text service
    console.log('[VideoProcessor] Audio extraction not yet implemented');
    return null;
  }

  /**
   * Cleanup temporary files
   * @param {string} tempDir - Temporary directory to clean
   */
  async cleanup(tempDir) {
    try {
      const files = await fs.readdir(tempDir);
      for (const file of files) {
        await fs.unlink(path.join(tempDir, file));
      }
      await fs.rmdir(tempDir);
      console.log('[VideoProcessor] Cleaned up temporary files');
    } catch (error) {
      console.error('[VideoProcessor] Cleanup error:', error.message);
    }
  }

  /**
   * Process video URL without downloading (for Gemini direct analysis)
   * @param {string} videoUrl - Video URL
   * @param {object} metadata - Video metadata
   * @returns {object} - Processed video data for AI analysis
   */
  prepareVideoForAI(videoUrl, metadata = {}) {
    const { duration, viewCount, author } = metadata;

    return {
      url: videoUrl,
      type: 'video',
      duration,
      analysisHints: {
        scanForTextOverlays: true,
        extractAudioNarration: true,
        identifyIngredients: true,
        trackCookingSteps: true,
        focusTimestamps: this.calculateFramePoints(duration || 60, 8, true),
        expectedSections: [
          { start: 0, end: 0.1, focus: 'ingredients_display' },
          { start: 0.1, end: 0.3, focus: 'preparation' },
          { start: 0.3, end: 0.7, focus: 'cooking_process' },
          { start: 0.7, end: 0.9, focus: 'assembly_plating' },
          { start: 0.9, end: 1.0, focus: 'final_dish' }
        ]
      },
      contextualInfo: {
        isPopular: viewCount > 10000,
        creator: author,
        platform: 'instagram_reel'
      }
    };
  }
}

module.exports = VideoProcessor;