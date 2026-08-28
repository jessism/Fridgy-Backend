// Manual TikTok photo upload — feeds the trackabite-tiktok-automation pipeline.
// The UI lives at trackabite.app/content (ContentUploadPage). Photos land in the
// tiktok-images bucket under manual/{batchId}/ with a manifest.json, then a
// GitHub workflow (manual_post.yml) builds the carousel and sends the TikTok draft.
const express = require('express');
const router = express.Router();
const multer = require('multer');
const crypto = require('crypto');
const axios = require('axios');
const sharp = require('sharp');
const { getServiceClient } = require('../config/supabase');
const { authenticateToken } = require('../middleware/auth');
const { requireAdmin } = require('../middleware/adminAuth');

const BUCKET = process.env.SUPABASE_BUCKET || 'tiktok-images';
const WORKFLOW_DISPATCH_URL =
  'https://api.github.com/repos/jessism/trackabite-tiktok-automation/actions/workflows/manual_post.yml/dispatches';
const ACTIONS_URL = 'https://github.com/jessism/trackabite-tiktok-automation/actions';

// Own multer instance: modern phone photos can exceed the shared 10MB limit
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024, files: 4 },
  fileFilter: (req, file, cb) => {
    // iOS sometimes sends HEIC as application/octet-stream
    if (file.mimetype.startsWith('image/') || file.mimetype === 'application/octet-stream') {
      cb(null, true);
    } else {
      cb(new Error('Only image files are allowed'));
    }
  }
});

// HEIC/HEIF → JPEG, bake in EXIF orientation, downscale, strip all metadata
// (no .withMetadata() — GPS/EXIF from phone photos must not reach TikTok).
async function toJpeg(buffer, mimetype) {
  let input = buffer;
  const isHeic = /hei[cf]/i.test(mimetype) ||
    (buffer.length > 12 && buffer.slice(4, 12).toString('ascii').startsWith('ftyphei'));
  if (isHeic) {
    const convert = require('heic-convert');
    input = Buffer.from(await convert({ buffer, format: 'JPEG', quality: 0.9 }));
  }
  return sharp(input)
    .rotate()
    .resize(2048, 2048, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 88 })
    .toBuffer();
}

async function dispatchWorkflow(batchId) {
  await axios.post(
    WORKFLOW_DISPATCH_URL,
    { ref: 'main', inputs: { batch_id: batchId } },
    {
      headers: {
        Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28'
      },
      timeout: 15000
    }
  );
}

// POST /api/tiktok-upload/submit
// multipart: photos = 2-4 image files (order matters), names = JSON array of strings
router.post('/submit', authenticateToken, requireAdmin, upload.array('photos', 4), async (req, res) => {
  try {
    const files = req.files || [];
    if (files.length < 2 || files.length > 4) {
      return res.status(400).json({
        success: false,
        error: `Need 2-4 photos, got ${files.length}`
      });
    }

    let names;
    try {
      names = JSON.parse(req.body.names || '[]');
    } catch (e) {
      return res.status(400).json({ success: false, error: 'names must be a JSON array' });
    }
    if (!Array.isArray(names) || names.length !== files.length) {
      return res.status(400).json({
        success: false,
        error: `names must be an array of ${files.length} strings (empty string = no name)`
      });
    }

    const batchId = 'mb' + Date.now().toString(36) + crypto.randomBytes(4).toString('hex');
    const supabase = getServiceClient();
    const manifestPhotos = [];

    // Sequential on purpose: parallel 25MB buffers + heic-convert spike memory
    for (let i = 0; i < files.length; i++) {
      let jpeg;
      try {
        jpeg = await toJpeg(files[i].buffer, files[i].mimetype);
      } catch (e) {
        console.error('[TikTokUpload] Could not process photo', i + 1, e.message);
        return res.status(400).json({
          success: false,
          error: `Photo ${i + 1} could not be processed as an image`
        });
      }

      const fileName = `photo_${i + 1}.jpg`;
      const { error: uploadError } = await supabase.storage
        .from(BUCKET)
        .upload(`manual/${batchId}/${fileName}`, jpeg, {
          contentType: 'image/jpeg',
          upsert: true
        });
      if (uploadError) {
        console.error('[TikTokUpload] Storage upload error:', uploadError);
        return res.status(500).json({
          success: false,
          error: `Failed to upload photo ${i + 1} to storage`
        });
      }
      manifestPhotos.push({ file: fileName, name: String(names[i] || '').trim() });
    }

    const manifest = {
      batch_id: batchId,
      created_at: new Date().toISOString(),
      photos: manifestPhotos
    };
    const { error: manifestError } = await supabase.storage
      .from(BUCKET)
      .upload(`manual/${batchId}/manifest.json`, Buffer.from(JSON.stringify(manifest, null, 2)), {
        contentType: 'application/json',
        upsert: true
      });
    if (manifestError) {
      console.error('[TikTokUpload] Manifest upload error:', manifestError);
      return res.status(500).json({ success: false, error: 'Failed to upload manifest' });
    }

    console.log(`[TikTokUpload] Batch ${batchId}: ${files.length} photos uploaded`);

    if (!process.env.GITHUB_TOKEN) {
      // Local-testing mode: photos are in the bucket, run the pipeline by hand
      return res.json({
        success: true,
        batch_id: batchId,
        dispatched: false,
        message: 'Photos uploaded. GITHUB_TOKEN not set, run the workflow manually.'
      });
    }

    try {
      await dispatchWorkflow(batchId);
    } catch (e) {
      console.error('[TikTokUpload] Workflow dispatch failed:', e.response?.status, e.message);
      return res.status(502).json({
        success: false,
        batch_id: batchId,
        error: 'Photos uploaded but workflow dispatch failed',
        hint: `Run "Manual Photo Post to TikTok" manually with this batch_id at ${ACTIONS_URL}`
      });
    }

    console.log(`[TikTokUpload] Batch ${batchId}: workflow dispatched`);
    return res.json({
      success: true,
      batch_id: batchId,
      dispatched: true,
      actions_url: ACTIONS_URL,
      message: 'Photos uploaded, TikTok pipeline started. Draft lands in your TikTok inbox in ~5 min.'
    });
  } catch (error) {
    console.error('[TikTokUpload] Error:', error);
    return res.status(500).json({ success: false, error: error.message || 'Upload failed' });
  }
});

module.exports = router;
