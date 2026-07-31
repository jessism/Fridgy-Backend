const fs = require('fs');
const { execSync } = require('child_process');

/**
 * Resolve a usable ffmpeg binary without assuming anything about the host.
 *
 * Order: FFMPEG_PATH env → well-known system locations → PATH (`which`) →
 * bundled ffmpeg-static binary → bare 'ffmpeg' (spawn PATH lookup).
 *
 * The old hardcoded '/usr/bin/ffmpeg' fallback broke every ffmpeg feature in
 * prod (audio transcription, keyframes, step frames) because Railway's image
 * doesn't put ffmpeg there. ffmpeg-static guarantees a binary in node_modules
 * regardless of the container image.
 */
function resolveFfmpegPath() {
  const envPath = process.env.FFMPEG_PATH;
  if (envPath && fs.existsSync(envPath)) {
    return { path: envPath, source: 'env' };
  }

  const systemCandidates = ['/usr/bin/ffmpeg', '/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg'];
  const systemPath = systemCandidates.find(p => fs.existsSync(p));
  if (systemPath) {
    return { path: systemPath, source: 'system' };
  }

  try {
    const whichPath = execSync('which ffmpeg', { encoding: 'utf8' }).trim();
    if (whichPath && fs.existsSync(whichPath)) {
      return { path: whichPath, source: 'PATH' };
    }
  } catch (whichError) {
    // not on PATH
  }

  try {
    const staticPath = require('ffmpeg-static');
    if (staticPath && fs.existsSync(staticPath)) {
      return { path: staticPath, source: 'ffmpeg-static' };
    }
  } catch (requireError) {
    // package not installed
  }

  return { path: 'ffmpeg', source: 'fallback' };
}

const resolved = resolveFfmpegPath();
console.log(`[FFmpeg] Resolved binary: ${resolved.path} (source: ${resolved.source})`);

module.exports = { ffmpegPath: resolved.path, ffmpegSource: resolved.source };
