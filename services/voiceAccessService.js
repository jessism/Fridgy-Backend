const { getServiceClient } = require('../config/supabase');
const subscriptionService = require('./subscriptionService');
const { TtsError } = require('./runpodTtsService');

// Who may use the premium cooking voices:
// - premium subscribers, always
// - free users, once: a 1-hour trial window starting the first time they
//   request premium-voice audio (tracked in users.voice_trial_started_at,
//   so it survives reinstalls)
const TRIAL_DURATION_MS = 1 * 60 * 60 * 1000;
const CACHE_TTL_MS = 5 * 60 * 1000;

// userId -> { at, isPremium, trialStartedAt } - sentence pipelining is
// chatty, so don't hit the DB on every request
const cache = new Map();

async function loadAccess(userId) {
  const cached = cache.get(userId);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return cached;
  }

  const [isPremium, trialStartedAt] = await Promise.all([
    subscriptionService.isPremium(userId).catch(() => false),
    getServiceClient()
      .from('users')
      .select('voice_trial_started_at')
      .eq('id', userId)
      .single()
      .then(({ data, error }) => {
        if (error) {
          // Column missing (migration not run yet) or lookup failure:
          // treat as "trial unavailable" rather than crashing
          console.warn('[VoiceAccess] Trial lookup failed:', error.message);
          return undefined;
        }
        return data?.voice_trial_started_at ? new Date(data.voice_trial_started_at) : null;
      }),
  ]);

  const entry = { at: Date.now(), isPremium, trialStartedAt };
  cache.set(userId, entry);
  return entry;
}

function trialState(trialStartedAt) {
  if (trialStartedAt === undefined) {
    return { trialAvailable: false, trialActive: false, trialUsed: true, trialActiveUntil: null };
  }
  if (trialStartedAt === null) {
    return { trialAvailable: true, trialActive: false, trialUsed: false, trialActiveUntil: null };
  }
  const until = trialStartedAt.getTime() + TRIAL_DURATION_MS;
  const active = Date.now() < until;
  return {
    trialAvailable: false,
    trialActive: active,
    trialUsed: true,
    trialActiveUntil: new Date(until).toISOString(),
  };
}

/** Access summary for the client UI (badges, paywall copy). */
async function getAccess(userId) {
  const { isPremium, trialStartedAt } = await loadAccess(userId);
  return { isPremium, ...trialState(trialStartedAt) };
}

/**
 * Gate for premium-voice synthesis. Premium users pass; free users pass
 * during their trial window (starting it on first use); everyone else
 * gets 403 PREMIUM_REQUIRED.
 */
async function ensurePremiumVoiceAccess(userId, requestId) {
  const { isPremium, trialStartedAt } = await loadAccess(userId);
  if (isPremium) return;

  if (trialStartedAt === null) {
    // First premium-voice use: start the one-time trial. The IS NULL guard
    // makes concurrent first-sentences race safely to a single start time.
    const { error } = await getServiceClient()
      .from('users')
      .update({ voice_trial_started_at: new Date().toISOString() })
      .eq('id', userId)
      .is('voice_trial_started_at', null);
    if (error) {
      console.warn(`[VoiceAccess:${requestId}] Failed to start trial:`, error.message);
      throw new TtsError('PREMIUM_REQUIRED', 'Premium voices require a subscription', 403);
    }
    invalidate(userId);
    console.log(`[VoiceAccess:${requestId}] Voice trial started for user ${userId}`);
    return;
  }

  const { trialActive } = trialState(trialStartedAt);
  if (trialActive) return;

  throw new TtsError('PREMIUM_REQUIRED', 'Premium voices require a subscription', 403);
}

/** Forget a user's cached access, e.g. after users.tier changes. */
function invalidate(userId) {
  cache.delete(userId);
}

module.exports = {
  getAccess,
  ensurePremiumVoiceAccess,
  invalidate,
};
