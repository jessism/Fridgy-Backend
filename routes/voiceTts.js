const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/auth');
const { voiceTtsSpeakLimiter, voiceTtsPrewarmLimiter } = require('../middleware/rateLimiter');
const runpodTts = require('../services/runpodTtsService');
const googleTts = require('../services/googleTtsService');

// Google-backed voices - warm managed API, no prewarm, MP3 output
const GOOGLE_VOICES = {
  fern: {
    id: 'fern',
    name: 'Nova',
    gender: 'female',
    description: 'Crisp and clear, ready in a snap',
  },
};

const isGoogleVoice = (voiceId) =>
  Object.prototype.hasOwnProperty.call(GOOGLE_VOICES, voiceId);

// Premium neural voices for cooking mode. Proxies a RunPod serverless TTS
// endpoint — the API key never leaves this server; clients only see these
// routes. (The older /api/tts Google TTS route is unauthenticated — flagged
// for cleanup separately; this route is the gated path.)

const MAX_TEXT_LENGTH = 500;

router.post('/speak', authMiddleware.authenticateToken, voiceTtsSpeakLimiter, async (req, res) => {
  const requestId = Math.random().toString(36).substring(7);
  const { text, voiceId } = req.body;

  if (!text || typeof text !== 'string' || !text.trim()) {
    return res.status(400).json({ success: false, error: 'Text is required', code: 'BAD_TEXT' });
  }
  if (text.length > MAX_TEXT_LENGTH) {
    return res.status(400).json({
      success: false,
      error: `Text too long (max ${MAX_TEXT_LENGTH} characters) — split into sentences`,
      code: 'TOO_LONG',
    });
  }
  if (!runpodTts.isKnownVoice(voiceId) && !isGoogleVoice(voiceId)) {
    return res.status(400).json({ success: false, error: 'Unknown voice', code: 'BAD_VOICE' });
  }

  // Abort (and cancel on RunPod) the moment the app gives up on this
  // sentence — user skipped the step, closed the modal, or timed out
  const controller = new AbortController();
  req.on('close', () => controller.abort());

  try {
    if (isGoogleVoice(voiceId)) {
      const mp3 = await googleTts.synthesize({ text: text.trim(), requestId });
      return res.json({ success: true, audioBase64: mp3.toString('base64'), format: 'mp3' });
    }
    const wav = await runpodTts.synthesize({
      text: text.trim(),
      voiceId,
      requestId,
      signal: controller.signal,
    });
    res.json({
      success: true,
      audioBase64: wav.toString('base64'),
      format: 'wav',
      sampleRate: 24000,
    });
  } catch (err) {
    if (res.headersSent || controller.signal.aborted) return;
    const status = err.status || 500;
    const code = err.code || 'TTS_FAILED';
    console.error(`[VoiceTTS:${requestId}] ${code}:`, err.message);
    res.status(status).json({ success: false, error: err.message, code });
  }
});

router.post('/prewarm', authMiddleware.authenticateToken, voiceTtsPrewarmLimiter, (req, res) => {
  // Google voices are always warm - never burn a RunPod job for them
  if (isGoogleVoice(req.body?.voiceId)) {
    return res.json({ success: true, warmed: true, reason: 'always-warm' });
  }
  const requestId = Math.random().toString(36).substring(7);
  const result = runpodTts.prewarm(requestId);
  res.json({ success: true, ...result });
});

router.get('/voices', authMiddleware.authenticateToken, (req, res) => {
  res.json({
    success: true,
    voices: [...Object.values(GOOGLE_VOICES), ...runpodTts.listVoices()],
  });
});

router.get('/preview/:voiceId', authMiddleware.authenticateToken, async (req, res) => {
  if (isGoogleVoice(req.params.voiceId)) {
    try {
      const mp3 = await googleTts.getPreviewMp3('preview');
      res.set('Content-Type', 'audio/mpeg');
      return res.send(mp3);
    } catch (err) {
      return res.status(err.status || 500).json({ success: false, error: err.message, code: err.code || 'TTS_FAILED' });
    }
  }
  // Whitelist check before the id goes anywhere near a filesystem path
  const filePath = runpodTts.previewPath(req.params.voiceId);
  if (!filePath) {
    return res.status(400).json({ success: false, error: 'Unknown voice', code: 'BAD_VOICE' });
  }
  res.sendFile(filePath);
});

module.exports = router;
