/**
 * Recipe share links: /r/<slug> pages that anyone can open without an account.
 *
 * Owns slug minting, the "is this row publicly readable" rule that both the
 * legacy /:id/public route and the new /share/:slug route enforce, the
 * privacy-stripped payload, and the share-time image durability pass.
 *
 * Plan: trackabite-mobile/MD_files/PLAN_SHARERECIPE_SEPT12.md
 */
const crypto = require('crypto');
const sharp = require('sharp');
const { getServiceClient } = require('../config/supabase');
const ApifyInstagramService = require('./apifyInstagramService');

const supabase = getServiceClient();

// 31 chars: no 0/o/1/l/i so a read-aloud or hand-typed link can't be
// mis-transcribed. 14 chars ≈ 69 bits — the slug is a capability token.
const TOKEN_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
const TOKEN_LENGTH = 14;
const TITLE_SLUG_MAX = 60;

const SLUG_RE = /^[a-z0-9-]{1,96}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Rows a stranger may read by id. Imports from public platforms are already
// visible to everyone through the Home shelves and the Messenger/Instagram
// bots link straight to them; manual / voice / scanned / ai_generated rows
// are the owner's own content and are only reachable once they share.
// Mirrors the adopt route and migration 085 — plus facebook/tiktok, which
// the bots and the import routes really do write.
const PUBLIC_SOURCES = ['instagram', 'facebook', 'tiktok', 'web', 'popular'];

// Everything the public page needs and nothing personal. Never user_id,
// user_notes, rating, is_favorite, times_cooked, drive_* or the owner's email.
const PUBLIC_FIELDS = [
  'id', 'title', 'summary', 'image', 'image_urls',
  'extendedIngredients', 'analyzedInstructions',
  'readyInMinutes', 'cookingMinutes', 'servings',
  'source_author', 'source_type', 'source_url',
  'nutrition', 'vegetarian', 'vegan', 'glutenFree', 'dairyFree',
  'cuisines', 'dishTypes',
];

const DEFAULT_WEB_ORIGIN = 'https://www.trackabite.app';

// Deliberately NOT FRONTEND_URL: that one is 'http://localhost:3000' in local
// .env files and its value on Railway can't be assumed. A share link must
// always point at the public site, so the correct value is the default and
// SHARE_WEB_ORIGIN only exists to override it (e.g. a staging domain).
function webOrigin() {
  return (process.env.SHARE_WEB_ORIGIN || DEFAULT_WEB_ORIGIN).replace(/\/+$/, '');
}

function buildShareUrl(slug) {
  return `${webOrigin()}/r/${slug}`;
}

/** "Miso Butter Salmón!" -> "miso-butter-salmon", capped at a word boundary. */
function slugifyTitle(text) {
  const base = String(text || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (base.length <= TITLE_SLUG_MAX) return base;
  const cut = base.slice(0, TITLE_SLUG_MAX);
  const lastDash = cut.lastIndexOf('-');
  return (lastDash > 20 ? cut.slice(0, lastDash) : cut).replace(/-+$/, '');
}

/** Unbiased token: reject bytes outside the largest multiple of 31 below 256. */
function randomToken(length = TOKEN_LENGTH) {
  const limit = 256 - (256 % TOKEN_ALPHABET.length); // 248
  let out = '';
  while (out.length < length) {
    const bytes = crypto.randomBytes(length * 2);
    for (let i = 0; i < bytes.length && out.length < length; i++) {
      if (bytes[i] < limit) out += TOKEN_ALPHABET[bytes[i] % TOKEN_ALPHABET.length];
    }
  }
  return out;
}

function mintSlug(title) {
  const base = slugifyTitle(title) || 'recipe';
  return `${base}-${randomToken()}`;
}

function isValidSlug(slug) {
  return typeof slug === 'string' && SLUG_RE.test(slug);
}

function isUuid(id) {
  return typeof id === 'string' && UUID_RE.test(id);
}

/** Steps across ALL instruction blocks — writers produce multi-block arrays and `[{name:'',steps:[]}]`. */
function countSteps(row) {
  if (!Array.isArray(row?.analyzedInstructions)) return 0;
  return row.analyzedInstructions.reduce((n, block) => {
    const steps = Array.isArray(block?.steps) ? block.steps : [];
    return n + steps.filter((s) => s && typeof s.step === 'string' && s.step.trim()).length;
  }, 0);
}

function countIngredients(row) {
  return Array.isArray(row?.extendedIngredients) ? row.extendedIngredients.length : 0;
}

/** An empty public page is a dead end for the visitor; refuse to mint one. */
function isShareable(row) {
  return countIngredients(row) > 0 && countSteps(row) > 0;
}

/** May a stranger holding the id read this row? (Legacy /:id/public rule.) */
function isPubliclyReadable(row) {
  if (!row) return false;
  if (row.visibility === 'public' || row.visibility === 'curated') return true;
  return PUBLIC_SOURCES.includes(row.source_type);
}

/** Privacy-stripped payload. `extras` are added verbatim (owner, ogImage, slug...). */
function toPublicRecipe(row, extras = {}) {
  const out = {};
  for (const key of PUBLIC_FIELDS) {
    if (row[key] !== undefined) out[key] = row[key];
  }
  return { ...out, ...extras };
}

const isDurableImage = (url) =>
  typeof url === 'string' && url.includes('supabase.co/storage/');

/**
 * Share time: make sure the hero image outlives the Instagram/TikTok CDN
 * signature it was imported with. Re-hosts into recipe-images and writes the
 * public URL back onto the row. Never throws — a failed re-host must not
 * block sharing; the page then falls back to the branded card.
 * Returns the durable URL or null.
 */
async function ensureDurableImage(row) {
  try {
    if (isDurableImage(row.image)) return row.image;

    const candidates = [row.image, ...(Array.isArray(row.image_urls) ? row.image_urls : [])]
      .filter((u) => typeof u === 'string' && /^https?:\/\//.test(u));
    if (candidates.length === 0) return null;

    const alreadyDurable = candidates.find(isDurableImage);
    let durable = alreadyDurable || null;

    if (!durable) {
      const apify = new ApifyInstagramService();
      for (const candidate of candidates.slice(0, 2)) {
        // Returns the recipe-images public URL or null; it never throws.
        durable = await apify.downloadInstagramImage(candidate, row.id, row.user_id);
        if (durable) break;
      }
    }

    if (!durable) return null;

    if (durable !== row.image) {
      const { error } = await supabase
        .from('saved_recipes')
        .update({ image: durable, updated_at: new Date().toISOString() })
        .eq('id', row.id);
      if (error) console.warn('[RecipeShare] Could not write back durable image:', error.message);
    }
    return durable;
  } catch (err) {
    console.warn('[RecipeShare] ensureDurableImage failed (non-blocking):', err.message);
    return null;
  }
}

// og:image:width/height decide whether Facebook/WhatsApp render a hero card or
// a thumbnail on the FIRST scrape. Read once per image URL and remember it;
// the process restarts often enough on Railway that this never grows large.
const dimensionCache = new Map();
const DIMENSION_CACHE_MAX = 500;

async function readImageDimensions(url) {
  if (!isDurableImage(url)) return null;
  if (dimensionCache.has(url)) return dimensionCache.get(url);

  let result = null;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    if (res.ok) {
      const buf = Buffer.from(await res.arrayBuffer());
      const meta = await sharp(buf).metadata();
      if (meta.width && meta.height) result = { width: meta.width, height: meta.height };
    }
  } catch (err) {
    console.warn('[RecipeShare] readImageDimensions failed:', err.message);
  }

  if (dimensionCache.size >= DIMENSION_CACHE_MAX) {
    dimensionCache.delete(dimensionCache.keys().next().value);
  }
  dimensionCache.set(url, result);
  return result;
}

/** ogImage + dimensions for a row; null ogImage means "use the branded card". */
async function buildOgImage(row) {
  const image = isDurableImage(row.image)
    ? row.image
    : (Array.isArray(row.image_urls) ? row.image_urls.find(isDurableImage) : null);
  if (!image) return { ogImage: null };
  const dims = await readImageDimensions(image);
  return dims
    ? { ogImage: image, ogImageWidth: dims.width, ogImageHeight: dims.height }
    : { ogImage: image };
}

async function lookupOwnerName(userId) {
  if (!userId) return null;
  const { data } = await supabase
    .from('users')
    .select('first_name')
    .eq('id', userId)
    .maybeSingle();
  return data?.first_name || null;
}

module.exports = {
  PUBLIC_SOURCES,
  buildShareUrl,
  slugifyTitle,
  mintSlug,
  isValidSlug,
  isUuid,
  countSteps,
  isShareable,
  isPubliclyReadable,
  toPublicRecipe,
  ensureDurableImage,
  buildOgImage,
  lookupOwnerName,
};
