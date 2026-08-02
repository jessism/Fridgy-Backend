const { TtsError } = require('./runpodTtsService');

// Google Cloud TTS backing for the "fern" cooking voice: a warm managed
// API - no cold starts, no concurrency management, first 1M chars/month
// free. MP3 on purpose: ~10x smaller than WAV over users' connections.
const GOOGLE_TTS_API_KEY = process.env.GOOGLE_TTS_API_KEY;
const VOICE_NAME = process.env.GOOGLE_TTS_VOICE_NAME || 'en-US-Neural2-F';
const DAILY_CHAR_CAP = parseInt(process.env.GOOGLE_TTS_DAILY_CHAR_CAP || '30000', 10);

const TTS_API_URL = 'https://texttospeech.googleapis.com/v1/text:synthesize';

const PREVIEW_LINE =
  "Hi, I'm Nova. First, bring a large pot of salted water to a boil, and let's make something delicious.";

// In-memory accounting - fine for the single Railway instance
let dailyCharCount = 0;
let dailyCharDate = new Date().toDateString();
let previewMp3 = null;

function isConfigured() {
  return Boolean(GOOGLE_TTS_API_KEY);
}

function countChars(n) {
  const today = new Date().toDateString();
  if (today !== dailyCharDate) {
    dailyCharDate = today;
    dailyCharCount = 0;
  }
  dailyCharCount += n;
  return dailyCharCount <= DAILY_CHAR_CAP;
}

/** Generate speech for one sentence. Returns a playable MP3 Buffer. */
async function synthesize({ text, requestId }) {
  if (!isConfigured()) {
    throw new TtsError('TTS_FAILED', 'Google TTS is not configured', 503);
  }
  if (!countChars(text.length)) {
    console.warn(`[GoogleTTS:${requestId}] Daily char cap (${DAILY_CHAR_CAP}) reached`);
    throw new TtsError('BUSY', 'Voice service daily limit reached', 503);
  }

  const startedAt = Date.now();
  const response = await fetch(`${TTS_API_URL}?key=${GOOGLE_TTS_API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      input: { text },
      voice: { languageCode: 'en-US', name: VOICE_NAME },
      audioConfig: {
        audioEncoding: 'MP3',
        speakingRate: 0.95,
      },
    }),
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    console.error(`[GoogleTTS:${requestId}] API error:`, response.status, errorData.error?.message);
    throw new TtsError(
      response.status === 429 ? 'BUSY' : 'TTS_FAILED',
      `Google TTS returned ${response.status}`,
      response.status === 429 ? 503 : 502
    );
  }

  const data = await response.json();
  if (!data.audioContent) {
    throw new TtsError('TTS_FAILED', 'Google TTS returned no audio', 502);
  }

  console.log(
    `[GoogleTTS:${requestId}] Synthesized ${text.length} chars (${VOICE_NAME}) in ${Date.now() - startedAt}ms — ${dailyCharCount}/${DAILY_CHAR_CAP} today`
  );
  return Buffer.from(data.audioContent, 'base64');
}

/** Preview sample, synthesized once per process and cached. */
async function getPreviewMp3(requestId) {
  if (!previewMp3) {
    previewMp3 = await synthesize({ text: PREVIEW_LINE, requestId });
  }
  return previewMp3;
}

module.exports = {
  synthesize,
  getPreviewMp3,
  isConfigured,
};
