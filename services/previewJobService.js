/**
 * Preview job service — backs the async Scan Recipe and Voice Recipe flows.
 *
 * Unlike URL imports (which save the recipe server-side), scan/voice return an
 * extracted recipe for the user to PREVIEW and edit before saving. The job's
 * result is therefore the recipe JSON itself, held in an in-memory store and
 * best-effort persisted to import_jobs.result_data (migration 072). The
 * in-memory copy is the fast path; the DB copy survives a poll after restart
 * once the migration is applied.
 */

const { getServiceClient } = require('../config/supabase');
const pushNotificationService = require('./pushNotificationService');

const supabase = getServiceClient();

const RESULT_TTL_MS = 30 * 60 * 1000; // 30 minutes
const results = new Map(); // jobId -> { recipe, expiresAt }

function pruneExpired() {
  const now = Date.now();
  for (const [jobId, entry] of results) {
    if (entry.expiresAt < now) results.delete(jobId);
  }
}

function storeResult(jobId, recipe) {
  pruneExpired();
  results.set(jobId, { recipe, expiresAt: Date.now() + RESULT_TTL_MS });
}

function getResult(jobId) {
  pruneExpired();
  return results.get(jobId)?.recipe || null;
}

/**
 * Create a processing job row. Returns the jobId or throws.
 * url is a placeholder label (column is NOT NULL and unused for scan/voice).
 */
async function createPreviewJob(userId, sourceType) {
  const jobId = `${sourceType}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

  const { error } = await supabase
    .from('import_jobs')
    .insert({
      id: jobId,
      user_id: userId,
      url: sourceType,
      source_type: sourceType,
      status: 'processing',
    });

  if (error) {
    console.error(`[PreviewJob] Failed to create ${sourceType} job:`, error);
    throw new Error('Failed to start processing');
  }

  return jobId;
}

/**
 * Mark a preview job completed: store recipe in memory, update DB
 * (result_data is best-effort — tolerated if migration 072 isn't applied yet),
 * and send a push notification.
 */
async function completePreviewJob(jobId, userId, recipe, sourceLabel) {
  storeResult(jobId, recipe);

  const baseUpdate = {
    status: 'completed',
    recipe_name: recipe.title || null,
    completed_at: new Date().toISOString(),
  };

  // Try persisting the recipe JSON too; fall back to status-only if the
  // result_data column doesn't exist yet.
  let { error } = await supabase
    .from('import_jobs')
    .update({ ...baseUpdate, result_data: recipe })
    .eq('id', jobId);

  if (error) {
    console.warn(`[PreviewJob] Job ${jobId}: result_data update failed (${error.message}); retrying without it`);
    ({ error } = await supabase.from('import_jobs').update(baseUpdate).eq('id', jobId));
    if (error) {
      console.error(`[PreviewJob] Job ${jobId}: status update failed:`, error);
    }
  }

  try {
    await pushNotificationService.sendToUser(userId, {
      title: 'Recipe ready!',
      body: `"${recipe.title || 'Your recipe'}" is ready to review`,
      tag: 'recipe-import',
      data: {
        screen: '/(tabs)',
        type: `recipe_${sourceLabel}_complete`,
        jobId,
      },
      requireInteraction: false,
    });
    console.log(`[PreviewJob] Job ${jobId}: push notification sent`);
  } catch (pushErr) {
    console.error(`[PreviewJob] Job ${jobId}: push failed:`, pushErr.message);
  }
}

/**
 * Mark a preview job failed and notify the user.
 */
async function failPreviewJob(jobId, userId, errorMessage, sourceLabel) {
  const { error } = await supabase
    .from('import_jobs')
    .update({
      status: 'failed',
      error: errorMessage || 'Processing failed',
      completed_at: new Date().toISOString(),
    })
    .eq('id', jobId);

  if (error) {
    console.error(`[PreviewJob] Job ${jobId}: failure update failed:`, error);
  }

  try {
    await pushNotificationService.sendToUser(userId, {
      title: sourceLabel === 'scan' ? 'Recipe scan failed' : 'Voice recipe failed',
      body: errorMessage || "We couldn't extract a recipe. Please try again.",
      tag: 'recipe-import',
      data: {
        screen: '/(tabs)',
        type: `recipe_${sourceLabel}_failed`,
        jobId,
      },
      requireInteraction: false,
    });
  } catch (pushErr) {
    console.error(`[PreviewJob] Job ${jobId}: failure push failed:`, pushErr.message);
  }
}

module.exports = {
  createPreviewJob,
  completePreviewJob,
  failPreviewJob,
  getResult,
};
