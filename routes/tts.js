const express = require('express');
const router = express.Router();

/**
 * Text-to-Speech API Route
 * Uses Google Cloud Text-to-Speech REST API with API Key
 * Falls back gracefully if not configured
 */

const TTS_API_URL = 'https://texttospeech.googleapis.com/v1/text:synthesize';

/**
 * POST /api/tts
 * Convert text to speech using Google Cloud TTS
 *
 * Body: { text: string, voice?: string }
 * Returns: audio/mpeg binary data
 */
router.post('/', async (req, res) => {
  const requestId = Math.random().toString(36).substring(7);
  console.log(`[TTS:${requestId}] Request received`);

  try {
    const { text, voice } = req.body;

    if (!text || typeof text !== 'string') {
      return res.status(400).json({ error: 'Text is required' });
    }

    if (text.length > 5000) {
      return res.status(400).json({ error: 'Text too long (max 5000 characters)' });
    }

    // Check for API key
    const apiKey = process.env.GOOGLE_TTS_API_KEY;
    if (!apiKey) {
      console.log(`[TTS:${requestId}] No API key configured`);
      return res.status(503).json({
        error: 'TTS service not configured',
        fallback: true,
        message: 'Use client-side Web Speech API as fallback'
      });
    }

    console.log(`[TTS:${requestId}] Synthesizing ${text.length} characters`);

    // Select voice based on preference or default to natural female voice
    const voiceName = voice || 'en-US-Neural2-F';

    // Call Google Cloud TTS REST API
    const response = await fetch(`${TTS_API_URL}?key=${apiKey}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        input: { text },
        voice: {
          languageCode: 'en-US',
          name: voiceName,
        },
        audioConfig: {
          audioEncoding: 'MP3',
          speakingRate: 0.95,
          pitch: 0,
          volumeGainDb: 0,
        },
      }),
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      console.error(`[TTS:${requestId}] API error:`, response.status, errorData);

      if (response.status === 403) {
        return res.status(503).json({
          error: 'TTS API key invalid or restricted',
          fallback: true,
          message: 'Check API key permissions'
        });
      }

      if (response.status === 429) {
        return res.status(429).json({
          error: 'TTS rate limit exceeded',
          fallback: true,
          message: 'Use client-side Web Speech API as fallback'
        });
      }

      return res.status(500).json({
        error: 'TTS synthesis failed',
        fallback: true,
        message: errorData.error?.message || 'Unknown error'
      });
    }

    const data = await response.json();

    if (!data.audioContent) {
      console.error(`[TTS:${requestId}] No audio content in response`);
      return res.status(500).json({
        error: 'TTS synthesis failed',
        fallback: true,
        message: 'No audio content returned'
      });
    }

    console.log(`[TTS:${requestId}] Synthesis complete, sending audio`);

    // Decode base64 audio content
    const audioBuffer = Buffer.from(data.audioContent, 'base64');

    // Send audio as binary response
    res.set({
      'Content-Type': 'audio/mpeg',
      'Content-Length': audioBuffer.length,
      'Cache-Control': 'public, max-age=86400',
    });

    res.send(audioBuffer);

  } catch (error) {
    console.error(`[TTS:${requestId}] Error:`, error.message);

    res.status(500).json({
      error: 'TTS synthesis failed',
      fallback: true,
      message: error.message
    });
  }
});

/**
 * GET /api/tts/voices
 * List available voices
 */
router.get('/voices', async (req, res) => {
  const apiKey = process.env.GOOGLE_TTS_API_KEY;

  if (!apiKey) {
    return res.status(503).json({ error: 'TTS service not configured' });
  }

  try {
    const response = await fetch(
      `https://texttospeech.googleapis.com/v1/voices?languageCode=en-US&key=${apiKey}`
    );

    if (!response.ok) {
      throw new Error(`API error: ${response.status}`);
    }

    const data = await response.json();

    // Filter to just Neural2 and Wavenet voices (highest quality)
    const highQualityVoices = (data.voices || [])
      .filter(v => v.name.includes('Neural2') || v.name.includes('Wavenet'))
      .map(v => ({
        name: v.name,
        gender: v.ssmlGender,
        naturalSampleRateHertz: v.naturalSampleRateHertz
      }));

    res.json({ voices: highQualityVoices });
  } catch (error) {
    console.error('[TTS] Error listing voices:', error.message);
    res.status(500).json({ error: 'Failed to list voices' });
  }
});

/**
 * GET /api/tts/health
 * Check if TTS service is available
 */
router.get('/health', (req, res) => {
  const apiKey = process.env.GOOGLE_TTS_API_KEY;

  res.json({
    available: !!apiKey,
    configured: !!apiKey,
    method: 'api_key'
  });
});

module.exports = router;
