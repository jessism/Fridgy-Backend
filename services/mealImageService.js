/**
 * Meal image service — a picture for a meal the user described in text.
 *
 * There is no photo to store, so we generate one. Cheapest path that already
 * exists: OpenRouter gpt-image-1-mini (imageGenerationService's fallback
 * provider) at low quality — the picture renders at 52px thumbnails and one
 * ~360px square, so low is plenty, and it is a few tenths of a cent.
 *
 * Cached by normalized dish name so "Breka Mediterranean panini" typed by two
 * users costs one generation. The cache row lives in ai_recipe_images under a
 * 'meal:'-prefixed hash so it can never collide with a recipe hash.
 *
 * Every export is non-fatal: a meal must still log when the picture fails.
 */

const crypto = require('crypto');
const sharp = require('sharp');
const imageGenerationService = require('./imageGenerationService');
const { getServiceClient } = require('../config/supabase');

const BUCKET = 'meal-photos';
const QUALITY = process.env.MEAL_IMAGE_QUALITY || 'low';

// Names the analysis falls back to when it can't identify a dish. Never
// cache a picture under these — every user's "meal" would share one photo.
const GENERIC_NAMES = new Set(['meal', 'home cooked meal', 'dine out meal', 'food', 'dish']);

// Unicode-aware: "Phở bò" and "麻婆豆腐" keep their letters; only punctuation,
// symbols and whitespace runs are collapsed.
function normalizeMealName(name) {
  const normalized = String(name || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\p{P}\p{S}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return GENERIC_NAMES.has(normalized) ? '' : normalized;
}

function mealImageHash(mealName) {
  return crypto
    .createHash('sha256')
    .update(`meal:${normalizeMealName(mealName)}`)
    .digest('hex')
    .substring(0, 24);
}

/**
 * Cached image URL for this dish name, or null. Never throws.
 */
async function getCachedMealImage(mealName) {
  if (!normalizeMealName(mealName)) return null;
  try {
    return await imageGenerationService.getCachedImage(mealImageHash(mealName));
  } catch (err) {
    console.warn('[MealImage] cache lookup failed:', err.message);
    return null;
  }
}

async function uploadToMealPhotos(base64DataUrl, hash) {
  const base64 = base64DataUrl.includes(',') ? base64DataUrl.split(',')[1] : base64DataUrl;
  const raw = Buffer.from(base64, 'base64');

  // gpt-image-1-mini returns a ~1.3MB 1024px PNG. The app shows this at 52px
  // thumbnails and one ~360px square, so an 800px JPEG (~80KB) is plenty.
  let buffer = raw;
  try {
    buffer = await sharp(raw)
      .resize(800, 800, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 80, mozjpeg: true })
      .toBuffer();
  } catch (err) {
    console.warn('[MealImage] compression failed, uploading raw:', err.message);
  }
  const fileName = `ai-generated/${hash}.jpg`;
  const supabase = getServiceClient();

  const { error } = await supabase.storage
    .from(BUCKET)
    .upload(fileName, buffer, {
      contentType: 'image/jpeg',
      cacheControl: '31536000',
      upsert: true,
    });
  if (error) throw new Error(error.message || JSON.stringify(error));

  const { data } = supabase.storage.from(BUCKET).getPublicUrl(fileName);
  if (!data?.publicUrl) throw new Error('No public URL for generated meal image');
  return data.publicUrl;
}

/**
 * Get-or-generate a picture for a text-described meal.
 * @returns {Promise<string|null>} public URL, or null on any failure
 */
async function generateMealImage({ mealName, keyIngredients = [], cuisine = '' }) {
  const normalized = normalizeMealName(mealName);
  if (!normalized) return null;

  const hash = mealImageHash(mealName);
  const cached = await getCachedMealImage(mealName);
  if (cached) return cached;

  const started = Date.now();
  try {
    const ingredients = Array.isArray(keyIngredients) && keyIngredients.length
      ? keyIngredients.slice(0, 5)
      : [mealName];

    const dataUrl = await imageGenerationService.generateImageWithOpenRouter(
      mealName,
      ingredients,
      cuisine,
      { quality: QUALITY }
    );
    const url = await uploadToMealPhotos(dataUrl, hash);

    // Best-effort cache; a miss just means one more generation next time.
    await imageGenerationService.cacheImage(hash, url, `meal:${normalized}`);

    console.log(`[MealImage] generated "${mealName}" in ${Date.now() - started}ms → ${url}`);
    return url;
  } catch (err) {
    console.error(`❌ MEAL_IMAGE_FAILED "${mealName}" after ${Date.now() - started}ms:`, err.message);
    return null;
  }
}

module.exports = {
  normalizeMealName,
  mealImageHash,
  getCachedMealImage,
  generateMealImage,
};
