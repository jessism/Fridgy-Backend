const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs').promises;
const fetch = require('node-fetch');
const path = require('path');
const os = require('os');

/**
 * AudioProcessor - Extracts and transcribes audio from videos
 *
 * Uses OpenRouter Gemini 2.5 Flash for audio transcription
 * Cost: ~$0.0006 per 10-second audio clip (very affordable)
 *
 * Methods:
 * - extractAudioFromVideo: Extract MP3 audio from video file
 * - transcribeWithOpenRouter: Transcribe audio using Gemini
 * - extractAndTranscribe: Combined extraction + transcription with cleanup
 */
class AudioProcessor {
  constructor() {
    this.tempDir = os.tmpdir();
    this.openrouterApiKey = process.env.OPENROUTER_API_KEY;
    this.transcriptionModel = 'google/gemini-2.5-flash'; // Verified working model
    this.apiUrl = 'https://openrouter.ai/api/v1/chat/completions';
  }

  /**
   * Extract audio from video file using ffmpeg
   * @param {string} videoPath - Path to video file
   * @param {object} options - Optional settings
   * @returns {Promise<string>} Path to extracted audio file
   */
  async extractAudioFromVideo(videoPath, options = {}) {
    const audioPath = path.join(this.tempDir, `audio_${Date.now()}.mp3`);

    console.log('[AudioProcessor] Extracting audio from video:', videoPath);

    return new Promise((resolve, reject) => {
      ffmpeg(videoPath)
        .noVideo()
        .audioCodec('libmp3lame')
        .audioBitrate('128k')
        .output(audioPath)
        .on('end', () => {
          console.log('[AudioProcessor] ✓ Audio extraction complete:', audioPath);
          resolve(audioPath);
        })
        .on('error', (err) => {
          console.error('[AudioProcessor] ✗ Audio extraction failed:', err);
          reject(err);
        })
        .run();
    });
  }

  /**
   * Transcribe audio using OpenRouter Gemini 2.5 Flash
   * @param {string} audioPath - Path to audio file
   * @param {object} options - Optional settings
   * @returns {Promise<object>} Transcript data with text, language, model
   */
  async transcribeWithOpenRouter(audioPath, options = {}) {
    console.log('[AudioProcessor] Transcribing audio with OpenRouter Gemini...');

    try {
      // Read audio file as base64
      const audioBuffer = await fs.readFile(audioPath);
      const audioBase64 = audioBuffer.toString('base64');

      console.log('[AudioProcessor] Audio file size:', (audioBuffer.length / 1024).toFixed(2), 'KB');

      // Call OpenRouter API
      const response = await fetch(this.apiUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.openrouterApiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: this.transcriptionModel,
          messages: [{
            role: 'user',
            content: [
              {
                type: 'input_audio',
                input_audio: {
                  data: audioBase64,
                  format: 'mp3'
                }
              },
              {
                type: 'text',
                text: 'Transcribe this audio exactly as spoken. Return only the transcript text with proper punctuation.'
              }
            ]
          }]
        })
      });

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`OpenRouter API error: ${response.status} - ${error}`);
      }

      const result = await response.json();
      const transcriptText = result.choices?.[0]?.message?.content || '';

      // Log usage/cost if available
      if (result.usage) {
        console.log('[AudioProcessor] Transcription cost:', {
          cost: result.usage.cost ? `$${result.usage.cost.toFixed(6)}` : 'N/A',
          audioTokens: result.usage.prompt_tokens_details?.audio_tokens || 'N/A',
          totalTokens: result.usage.total_tokens
        });
      }

      console.log('[AudioProcessor] ✓ Transcription complete:', {
        textLength: transcriptText.length,
        preview: transcriptText.substring(0, 100) || 'Empty'
      });

      return {
        text: transcriptText,
        language: options.language || 'en',
        model: this.transcriptionModel,
        cost: result.usage?.cost || 0,
        tokens: result.usage?.total_tokens || 0
      };

    } catch (error) {
      console.error('[AudioProcessor] ✗ Transcription failed:', error.message);
      throw error;
    }
  }

  /**
   * Extract audio and transcribe in one call
   * Includes cleanup of temporary audio file
   * @param {string} videoPath - Path to video file
   * @param {object} options - Optional settings
   * @returns {Promise<object>} Transcript data
   */
  async extractAndTranscribe(videoPath, options = {}) {
    let audioPath = null;

    try {
      // Step 1: Extract audio
      audioPath = await this.extractAudioFromVideo(videoPath, options);

      // Step 2: Check audio file size (detect silent videos)
      const stats = await fs.stat(audioPath);
      const sizeKB = stats.size / 1024;

      console.log('[AudioProcessor] Audio file size:', sizeKB.toFixed(2), 'KB');

      if (stats.size < 1000) {
        throw new Error('Audio file too small - video may be silent or have no audio track');
      }

      // Step 3: Transcribe
      const transcript = await this.transcribeWithOpenRouter(audioPath, options);

      // Step 4: Clean up audio file
      await fs.unlink(audioPath);
      console.log('[AudioProcessor] ✓ Temp audio file cleaned up');

      return transcript;

    } catch (error) {
      // Clean up on error
      if (audioPath) {
        try {
          await fs.unlink(audioPath);
          console.log('[AudioProcessor] Cleaned up audio file after error');
        } catch (e) {
          console.warn('[AudioProcessor] Failed to clean up audio file:', e.message);
        }
      }
      throw error;
    }
  }
}

module.exports = AudioProcessor;
