const fs = require('fs');
const path = require('path');

// RunPod serverless TTS (Qwen3-TTS). Audio is only delivered via /stream —
// /status reports COMPLETED with an empty output, so never read audio from it.
const RUNPOD_API_KEY = process.env.RUNPOD_API_KEY;
const RUNPOD_TTS_ENDPOINT_ID = process.env.RUNPOD_TTS_ENDPOINT_ID;
const DAILY_JOB_CAP = parseInt(process.env.RUNPOD_DAILY_JOB_CAP || '2000', 10);

const STREAM_POLL_MS = 75;
// Chunks can land on a page after the one that reports COMPLETED; skipping
// this drain clips the last word off the clip
const DRAIN_POLLS_AFTER_COMPLETE = 3;
const SYNTH_HARD_CAP_MS = 60000;
const PREWARM_COOLDOWN_MS = 60000;
// Donated GPU capacity: never more than 2 jobs in flight
const MAX_CONCURRENT_JOBS = 2;
const SEMAPHORE_WAIT_MS = 3000;

const SAMPLE_RATE = 24000;

const VOICES_DIR = path.join(__dirname, '../assets/voices');

const VOICE_META = {
  marigold: {
    name: 'Rosie',
    gender: 'female',
    description: 'Warm mellow alto, mid-30s — patient cooking-teacher energy',
  },
  clementine: {
    name: 'Sunny',
    gender: 'female',
    description: 'Bright, light, gently cheerful, mid-20s — crisp and encouraging',
  },
  sage: {
    name: 'Sage',
    gender: 'male',
    description: 'Warm relaxed baritone, late 30s — calm, reassuring chef',
  },
};

const VOICES = {};
for (const id of Object.keys(VOICE_META)) {
  VOICES[id] = {
    ...VOICE_META[id],
    vcpBase64: fs.readFileSync(path.join(VOICES_DIR, `${id}.vcp.b64.txt`), 'utf8').trim(),
  };
}

// In-memory job accounting. Fine for the single Railway instance — revisit
// (shared store) if the backend is ever scaled horizontally.
let jobsInFlight = 0;
let lastJobFinishedAt = 0;
let lastPrewarmAt = 0;
let dailyJobCount = 0;
let dailyJobDate = new Date().toDateString();

function countJob() {
  const today = new Date().toDateString();
  if (today !== dailyJobDate) {
    dailyJobDate = today;
    dailyJobCount = 0;
  }
  dailyJobCount++;
  return dailyJobCount <= DAILY_JOB_CAP;
}

function isConfigured() {
  return Boolean(RUNPOD_API_KEY && RUNPOD_TTS_ENDPOINT_ID);
}

function isKnownVoice(voiceId) {
  return Object.prototype.hasOwnProperty.call(VOICES, voiceId);
}

function listVoices() {
  return Object.entries(VOICE_META).map(([id, meta]) => ({ id, ...meta }));
}

function previewPath(voiceId) {
  if (!isKnownVoice(voiceId)) return null;
  return path.join(VOICES_DIR, 'previews', `${voiceId}.wav`);
}

function makeWavHeader(pcmByteLength) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + pcmByteLength, 4);
  h.write('WAVE', 8);
  h.write('fmt ', 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); // PCM
  h.writeUInt16LE(1, 22); // mono
  h.writeUInt32LE(SAMPLE_RATE, 24);
  h.writeUInt32LE(SAMPLE_RATE * 2, 28); // byte rate (16-bit mono)
  h.writeUInt16LE(2, 32); // block align
  h.writeUInt16LE(16, 34); // bits per sample
  h.write('data', 36);
  h.writeUInt32LE(pcmByteLength, 40);
  return h;
}

function runpodUrl(pathname) {
  return `https://api.runpod.ai/v2/${RUNPOD_TTS_ENDPOINT_ID}/${pathname}`;
}

function runpodHeaders() {
  return {
    'Authorization': `Bearer ${RUNPOD_API_KEY}`,
    'Content-Type': 'application/json',
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function cancelJob(jobId, requestId) {
  try {
    await fetch(runpodUrl(`cancel/${jobId}`), { method: 'POST', headers: runpodHeaders() });
    console.log(`[VoiceTTS:${requestId}] Cancelled RunPod job ${jobId}`);
  } catch (err) {
    console.warn(`[VoiceTTS:${requestId}] Cancel failed for ${jobId}:`, err.message);
  }
}

class TtsError extends Error {
  constructor(code, message, status = 500) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

async function acquireSlot() {
  const deadline = Date.now() + SEMAPHORE_WAIT_MS;
  while (jobsInFlight >= MAX_CONCURRENT_JOBS) {
    if (Date.now() > deadline) {
      throw new TtsError('BUSY', 'Voice service is busy, try again shortly', 503);
    }
    await sleep(100);
  }
  jobsInFlight++;
}

function releaseSlot() {
  jobsInFlight = Math.max(0, jobsInFlight - 1);
  lastJobFinishedAt = Date.now();
}

/**
 * Generate speech for one sentence. Returns a complete playable WAV Buffer.
 * `signal` aborts the job (and cancels it on RunPod) when the client goes away.
 */
async function synthesize({ text, voiceId, requestId, signal }) {
  if (!isConfigured()) {
    throw new TtsError('TTS_FAILED', 'Voice service is not configured', 503);
  }
  if (!countJob()) {
    console.warn(`[VoiceTTS:${requestId}] Daily job cap (${DAILY_JOB_CAP}) reached`);
    throw new TtsError('BUSY', 'Voice service daily limit reached', 503);
  }

  await acquireSlot();
  const startedAt = Date.now();
  let jobId = null;

  try {
    const runRes = await fetch(runpodUrl('run'), {
      method: 'POST',
      headers: runpodHeaders(),
      signal,
      body: JSON.stringify({
        input: {
          text,
          vcp_base64: VOICES[voiceId].vcpBase64,
          language: 'English',
          // Tuned for cross-sentence voice consistency — do not raise temperature
          temperature: 0.8,
          top_k: 27,
          // 4 smooths chunk onsets for assembled clips (2 is for live streaming)
          chunk_size: 4,
          response_format: 'pcm',
        },
      }),
    });

    if (!runRes.ok) {
      throw new TtsError('TTS_FAILED', `RunPod /run returned ${runRes.status}`, 502);
    }
    ({ id: jobId } = await runRes.json());
    if (!jobId) {
      throw new TtsError('TTS_FAILED', 'RunPod /run returned no job id', 502);
    }

    const pcmChunks = [];
    let completed = false;
    let drainsLeft = DRAIN_POLLS_AFTER_COMPLETE;

    while (!completed || drainsLeft > 0) {
      if (signal?.aborted) {
        throw new TtsError('TTS_FAILED', 'Client aborted', 499);
      }
      if (Date.now() - startedAt > SYNTH_HARD_CAP_MS) {
        throw new TtsError('TTS_FAILED', 'TTS generation timed out', 504);
      }

      const streamRes = await fetch(runpodUrl(`stream/${jobId}`), {
        headers: runpodHeaders(),
        signal,
      });
      if (!streamRes.ok) {
        throw new TtsError('TTS_FAILED', `RunPod /stream returned ${streamRes.status}`, 502);
      }
      const data = await streamRes.json();

      for (const item of data.stream || []) {
        const payload = item.output || item;
        if (payload?.audio_chunk_base64) {
          pcmChunks.push(Buffer.from(payload.audio_chunk_base64, 'base64'));
        }
      }

      if (data.status === 'FAILED') {
        throw new TtsError('TTS_FAILED', 'RunPod job failed', 502);
      }
      if (completed) {
        drainsLeft--;
      } else if (data.status === 'COMPLETED') {
        completed = true;
      }
      await sleep(STREAM_POLL_MS);
    }

    const pcm = Buffer.concat(pcmChunks);
    if (pcm.length === 0) {
      throw new TtsError('TTS_FAILED', 'RunPod job produced no audio', 502);
    }

    console.log(
      `[VoiceTTS:${requestId}] Synthesized ${text.length} chars → ${pcm.length} bytes PCM in ${Date.now() - startedAt}ms (job ${jobId})`
    );
    return Buffer.concat([makeWavHeader(pcm.length), pcm]);
  } catch (err) {
    if (jobId) cancelJob(jobId, requestId);
    if (err.name === 'AbortError') {
      throw new TtsError('TTS_FAILED', 'Client aborted', 499);
    }
    throw err;
  } finally {
    releaseSlot();
  }
}

/**
 * Wake a cold worker before real text arrives. Fire-and-forget: responds
 * immediately, drains the throwaway job in the background.
 */
function prewarm(requestId) {
  const now = Date.now();
  if (now - lastPrewarmAt < PREWARM_COOLDOWN_MS) {
    return { warmed: false, reason: 'cooldown' };
  }
  // A job in flight (or just finished) means a worker is already warm —
  // and a prewarm alongside two pipelined sentences would break the
  // 2-concurrent-jobs etiquette
  if (jobsInFlight > 0 || now - lastJobFinishedAt < PREWARM_COOLDOWN_MS) {
    return { warmed: false, reason: 'already-warm' };
  }
  if (!isConfigured() || !countJob()) {
    return { warmed: false, reason: 'unavailable' };
  }

  lastPrewarmAt = now;
  (async () => {
    try {
      // Empty text fails validation *after* the model loads — which is the point
      const runRes = await fetch(runpodUrl('run'), {
        method: 'POST',
        headers: runpodHeaders(),
        body: JSON.stringify({ input: { text: '' } }),
      });
      if (!runRes.ok) return;
      const { id: jobId } = await runRes.json();
      if (!jobId) return;
      const deadline = Date.now() + 45000;
      while (Date.now() < deadline) {
        const res = await fetch(runpodUrl(`status/${jobId}`), { headers: runpodHeaders() });
        if (!res.ok) return;
        const { status } = await res.json();
        if (status === 'COMPLETED' || status === 'FAILED' || status === 'CANCELLED') return;
        await sleep(1000);
      }
      cancelJob(jobId, requestId);
    } catch (err) {
      console.warn(`[VoiceTTS:${requestId}] Prewarm error:`, err.message);
    }
  })();

  return { warmed: true };
}

module.exports = {
  synthesize,
  prewarm,
  isKnownVoice,
  listVoices,
  previewPath,
  isConfigured,
  TtsError,
};
