const fs = require('fs').promises;
const path = require('path');
const os = require('os');
const { getServiceClient } = require('../config/supabase');

// Optional ffmpeg — without it the background pass silently no-ops and
// recipes stay text-only. Resolve the binary from FFMPEG_PATH, well-known
// locations (Railway nixpacks, Homebrew), or PATH as a last resort.
let ffmpeg = null;
let resolvedFfmpegPath = null;
try {
  ffmpeg = require('fluent-ffmpeg');
  const fsSync = require('fs');
  const candidates = [
    process.env.FFMPEG_PATH,
    '/usr/bin/ffmpeg',
    '/opt/homebrew/bin/ffmpeg',
    '/usr/local/bin/ffmpeg',
  ].filter(Boolean);
  resolvedFfmpegPath = candidates.find(p => fsSync.existsSync(p)) || null;
  if (!resolvedFfmpegPath) {
    // Railway nixpacks installs ffmpeg on PATH (not /usr/bin) — resolve it
    try {
      const { execSync } = require('child_process');
      resolvedFfmpegPath = execSync('which ffmpeg', { encoding: 'utf8' }).trim() || null;
    } catch (whichError) {
      resolvedFfmpegPath = null;
    }
  }
  // Last resort: bare 'ffmpeg' makes spawn do its own PATH lookup — and it
  // must always be set per-command, otherwise the module-global
  // /usr/bin/ffmpeg (set by videoProcessor/audioProcessor at load) wins
  if (!resolvedFfmpegPath) resolvedFfmpegPath = 'ffmpeg';
  console.log('[StepFrames] Using ffmpeg at:', resolvedFfmpegPath);
} catch (error) {
  console.warn('[StepFrames] FFmpeg not available - step frame extraction disabled');
}

const PASS_TIMEOUT_MS = 60 * 1000;

/**
 * Background pass that attaches a video screenshot to each recipe step it can
 * visually match. Runs AFTER the recipe row is saved — fire-and-forget, never
 * awaited by the import request path, and never allowed to throw out.
 *
 * Owns the temp mp4: deletes it (and its frame dir) in all outcomes.
 *
 * @param {object} params
 * @param {string} params.recipeId - saved_recipes.id (already inserted)
 * @param {string} params.userId
 * @param {Array<{number: number, step: string}>} params.steps
 * @param {string} params.localVideoPath - downloaded mp4 on local disk
 * @param {number} params.videoDuration - seconds
 * @param {Function} params.callAI - bound MultiModalExtractor.callAI(prompt, mediaContent, modelOverride)
 */
async function annotateStepFramesInBackground({ recipeId, userId, steps, localVideoPath, videoDuration, callAI }) {
  const startTime = Date.now();
  let tempFrameDir = null;

  try {
    if (!localVideoPath) return;
    if (!ffmpeg || !recipeId || !userId || !callAI || !Array.isArray(steps) || steps.length === 0) {
      return;
    }

    const run = async () => {
      // ── 1. Sample candidate frames from the local mp4 ──────────────────
      const duration = Number(videoDuration) || (await probeDuration(localVideoPath));
      if (!duration || duration < 3) {
        console.log('[StepFrames] No usable video duration, skipping');
        return;
      }

      const frameCount = Math.max(8, Math.min(16, Math.round(duration / 5)));
      const usable = Math.max(duration - 2, 1); // avoid first/last 1s (title cards, end freeze)
      const timestamps = [];
      for (let i = 0; i < frameCount; i++) {
        timestamps.push(Math.round((1 + (usable * (i + 0.5)) / frameCount) * 10) / 10);
      }

      tempFrameDir = path.join(os.tmpdir(), `stepframes_${recipeId}_${Date.now()}`);
      await fs.mkdir(tempFrameDir, { recursive: true });

      const candidates = [];
      for (const ts of timestamps) {
        const framePath = path.join(tempFrameDir, `f_${String(ts).replace('.', '_')}.jpg`);
        try {
          await new Promise((resolve, reject) => {
            const cmd = ffmpeg(localVideoPath);
            // Per-command path: other services set the module-global ffmpeg
            // path to /usr/bin/ffmpeg, which doesn't exist on dev machines
            if (resolvedFfmpegPath) cmd.setFfmpegPath(resolvedFfmpegPath);
            cmd
              .seekInput(ts)
              .frames(1)
              .outputOptions(['-vf', 'scale=480:-2', '-q:v', '5'])
              .output(framePath)
              .on('end', resolve)
              .on('error', reject)
              .run();
          });
          const buffer = await fs.readFile(framePath);
          candidates.push({ timestamp: ts, buffer });
        } catch (frameError) {
          console.warn(`[StepFrames] Frame at ${ts}s failed:`, frameError.message);
        }
      }

      if (candidates.length < 2) {
        console.log('[StepFrames] Too few candidate frames extracted, skipping');
        return;
      }
      console.log(`[StepFrames] Recipe ${recipeId}: ${candidates.length}/${frameCount} candidate frames extracted`);

      // ── 2. One cheap AI call to map steps → frames ──────────────────────
      const prompt = buildMappingPrompt(steps, candidates);
      const mediaContent = candidates.map(c => ({
        type: 'image',
        url: `data:image/jpeg;base64,${c.buffer.toString('base64')}`
      }));

      const response = await callAI(prompt, mediaContent, 'google/gemini-2.5-flash-lite');
      const mappings = parseMappings(response, steps.length, candidates.length);
      const matched = mappings.filter(m => m.frame !== null);
      console.log(`[StepFrames] Recipe ${recipeId}: mapped ${matched.length}/${steps.length} steps to frames`);
      if (matched.length === 0) return;

      // ── 3. Upload only the chosen frames ────────────────────────────────
      const supabase = getServiceClient();
      const uploads = await Promise.allSettled(matched.map(async (m) => {
        const candidate = candidates[m.frame];
        const fileName = `${userId}/steps/${recipeId}-s${m.step}.jpg`;
        const { error: uploadError } = await supabase.storage
          .from('recipe-images')
          .upload(fileName, candidate.buffer, {
            contentType: 'image/jpeg',
            cacheControl: '31536000',
            upsert: true
          });
        if (uploadError) throw new Error(uploadError.message);
        const { data: urlData } = supabase.storage.from('recipe-images').getPublicUrl(fileName);
        if (!urlData?.publicUrl) throw new Error('No public URL returned');
        return { step: m.step, image: urlData.publicUrl, frameTimestamp: candidate.timestamp };
      }));

      const uploaded = uploads
        .filter(u => u.status === 'fulfilled')
        .map(u => u.value);
      if (uploaded.length === 0) {
        console.warn(`[StepFrames] Recipe ${recipeId}: all frame uploads failed`);
        return;
      }

      // ── 4. Merge onto the row's CURRENT steps by step number ────────────
      // Re-read instead of using our `steps` copy so an edit made in the
      // seconds since import isn't clobbered.
      const { data: row, error: readError } = await supabase
        .from('saved_recipes')
        .select('analyzedInstructions')
        .eq('id', recipeId)
        .eq('user_id', userId)
        .single();
      if (readError || !row?.analyzedInstructions?.[0]?.steps) {
        console.warn(`[StepFrames] Recipe ${recipeId}: could not re-read instructions:`, readError?.message);
        return;
      }

      const byStep = new Map(uploaded.map(u => [u.step, u]));
      const updatedInstructions = row.analyzedInstructions.map((group, gi) => {
        if (gi !== 0 || !Array.isArray(group.steps)) return group;
        return {
          ...group,
          steps: group.steps.map(s => {
            const match = byStep.get(s.number);
            return match ? { ...s, image: match.image, frameTimestamp: match.frameTimestamp } : s;
          })
        };
      });

      const { error: updateError } = await supabase
        .from('saved_recipes')
        .update({ analyzedInstructions: updatedInstructions })
        .eq('id', recipeId)
        .eq('user_id', userId);
      if (updateError) {
        console.warn(`[StepFrames] Recipe ${recipeId}: update failed:`, updateError.message);
        return;
      }

      console.log(`[StepFrames] Recipe ${recipeId}: attached ${uploaded.length} step images in ${((Date.now() - startTime) / 1000).toFixed(1)}s`);
    };

    let timer;
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Step frame pass timed out after ${PASS_TIMEOUT_MS / 1000}s`)), PASS_TIMEOUT_MS);
    });
    await Promise.race([run(), deadline]).finally(() => clearTimeout(timer));

  } catch (error) {
    // Never propagate — a frame failure must not affect anything else
    console.warn(`[StepFrames] Recipe ${recipeId}: pass failed (recipe stays text-only):`, error.message);
  } finally {
    if (localVideoPath) await fs.unlink(localVideoPath).catch(() => {});
    if (tempFrameDir) await fs.rm(tempFrameDir, { recursive: true, force: true }).catch(() => {});
  }
}

function buildMappingPrompt(steps, candidates) {
  const stepList = steps.map(s => `${s.number}. ${s.step}`).join('\n');
  const frameList = candidates.map((c, i) => `Frame ${i} at ${c.timestamp}s`).join(', ');

  return `You match cooking-video frames to recipe steps.

RECIPE STEPS:
${stepList}

You are given ${candidates.length} frames sampled from the cooking video, attached in chronological order: ${frameList}.

For each step, choose the ONE frame (by its 0-based index) that clearly shows that step being performed or its immediate result.
Rules:
- Only assign a frame if the step's action or result is actually visible in it. Talking-head shots, title cards, or unrelated footage do NOT count.
- Each frame may be assigned to at most one step.
- Steps generally occur in video order, so assignments should be roughly chronological.
- If no frame clearly shows a step, use null for that step. It is normal for several steps to be null.

Respond with JSON only, no other text:
{"mappings":[{"step":1,"frame":3},{"step":2,"frame":null}]}`;
}

/**
 * Parse and defensively validate the mapping response: indices in range,
 * each frame used at most once (first claim wins).
 */
function parseMappings(response, stepCount, frameCount) {
  let parsed;
  try {
    const jsonMatch = String(response).match(/\{[\s\S]*\}/);
    parsed = JSON.parse(jsonMatch ? jsonMatch[0] : response);
  } catch (e) {
    console.warn('[StepFrames] Could not parse mapping response:', e.message);
    return [];
  }

  const raw = Array.isArray(parsed?.mappings) ? parsed.mappings : [];
  const usedFrames = new Set();
  const usedSteps = new Set();
  const mappings = [];

  for (const m of raw) {
    const step = Number(m?.step);
    if (!Number.isInteger(step) || step < 1 || step > stepCount || usedSteps.has(step)) continue;
    usedSteps.add(step);

    let frame = m?.frame;
    if (frame === null || frame === undefined) {
      mappings.push({ step, frame: null });
      continue;
    }
    frame = Number(frame);
    if (!Number.isInteger(frame) || frame < 0 || frame >= frameCount || usedFrames.has(frame)) {
      mappings.push({ step, frame: null });
      continue;
    }
    usedFrames.add(frame);
    mappings.push({ step, frame });
  }
  return mappings;
}

/** Fallback duration probe when the scraper didn't report one. */
function probeDuration(localVideoPath) {
  return new Promise((resolve) => {
    if (!ffmpeg) return resolve(null);
    ffmpeg.ffprobe(localVideoPath, (err, metadata) => {
      if (err) return resolve(null);
      resolve(metadata?.format?.duration ? Math.floor(metadata.format.duration) : null);
    });
  });
}

module.exports = { annotateStepFramesInBackground };
