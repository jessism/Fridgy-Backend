/**
 * Admin promo codes API — backs trackabite.app/admin/promos.
 * Every route: authenticated + users.is_admin.
 *
 * The promo_codes ROW is the gate. validatePromoCode / applyPromoCode
 * (controller/subscriptionController.js) check `active`, `expires_at` and
 * `max_redemptions` vs `times_redeemed` on this table, then insert
 * user_promo_codes and apply the discount to Stripe. `stripe_coupon_id`
 * only links the row to the Stripe coupon carrying the actual discount.
 * (PROMO_CODE_SETUP_GUIDE.md's "Stripe dashboard only" wording is
 * misleading — the DB row is the live path.)
 *
 * So this router verifies a coupon EXISTS in Stripe before saving a row
 * that points at it, and never creates or mutates anything in Stripe.
 *
 * Stripe / web checkout only — iOS purchases use Apple offer codes,
 * managed in App Store Connect.
 */
const express = require('express');
const { authenticateToken } = require('../middleware/auth');
const { requireAdmin } = require('../middleware/adminAuth');
const { getServiceClient } = require('../config/supabase');
const { isInternalAccount } = require('../services/internalAccounts');
// Lazy: constructing the Stripe client throws if STRIPE_SECRET_KEY is absent,
// and a route module that throws on require takes the whole server down at
// boot. Building it on first use keeps that failure inside one request.
let stripeClient = null;
const getStripe = () => {
  if (!stripeClient) stripeClient = require('stripe')(process.env.STRIPE_SECRET_KEY);
  return stripeClient;
};

const router = express.Router();
router.use(authenticateToken, requireAdmin);

const DISCOUNT_TYPES = ['percent', 'fixed'];
const DURATIONS = ['once', 'repeating', 'forever'];
const CODE_RE = /^[A-Z0-9_-]{3,50}$/;

/**
 * timesRedeemed is the counter applyPromoCode bumps; redemptions is the
 * number of user_promo_codes rows actually recorded. These currently
 * disagree in production (counter 20, rows 0), so both are surfaced
 * rather than silently reconciled.
 */
const shape = (row, redemptions) => ({
  id: row.id,
  code: row.code,
  stripeCouponId: row.stripe_coupon_id,
  discountType: row.discount_type,
  discountValue: row.discount_value === null ? null : Number(row.discount_value),
  duration: row.duration,
  durationInMonths: row.duration_in_months,
  maxRedemptions: row.max_redemptions,
  timesRedeemed: row.times_redeemed,
  redemptions: redemptions || 0,
  active: row.active,
  expiresAt: row.expires_at,
  createdAt: row.created_at,
});

/** Mirrors the CHECK constraints in migrations/001_create_subscription_tables.sql. */
function validateCreate(body) {
  const code = String(body.code || '').trim().toUpperCase();
  if (!CODE_RE.test(code)) {
    return { error: 'code must be 3-50 characters of A-Z, 0-9, underscore or hyphen' };
  }

  const stripeCouponId = String(body.stripeCouponId || '').trim();
  if (!stripeCouponId) return { error: 'stripeCouponId is required' };

  const discountType = body.discountType;
  if (!DISCOUNT_TYPES.includes(discountType)) {
    return { error: `discountType must be one of: ${DISCOUNT_TYPES.join(', ')}` };
  }

  const discountValue = Number(body.discountValue);
  if (!Number.isFinite(discountValue) || discountValue < 0) {
    return { error: 'discountValue must be a number >= 0' };
  }
  if (discountType === 'percent' && discountValue > 100) {
    return { error: 'discountValue must be <= 100 when discountType is percent' };
  }

  const duration = body.duration;
  if (!DURATIONS.includes(duration)) {
    return { error: `duration must be one of: ${DURATIONS.join(', ')}` };
  }

  // duration_in_months is required iff repeating, and the CHECK demands > 0.
  let durationInMonths = null;
  if (duration === 'repeating') {
    durationInMonths = parseInt(body.durationInMonths, 10);
    if (!Number.isInteger(durationInMonths) || durationInMonths <= 0) {
      return { error: 'durationInMonths must be a positive integer when duration is repeating' };
    }
  } else if (body.durationInMonths != null) {
    return { error: 'durationInMonths is only valid when duration is repeating' };
  }

  let maxRedemptions = null;
  if (body.maxRedemptions != null) {
    maxRedemptions = parseInt(body.maxRedemptions, 10);
    if (!Number.isInteger(maxRedemptions) || maxRedemptions <= 0) {
      return { error: 'maxRedemptions must be a positive integer' };
    }
  }

  let expiresAt = null;
  if (body.expiresAt != null && body.expiresAt !== '') {
    const d = new Date(body.expiresAt);
    if (Number.isNaN(d.getTime())) return { error: 'expiresAt must be an ISO date string' };
    expiresAt = d.toISOString();
  }

  return {
    value: {
      code,
      stripe_coupon_id: stripeCouponId,
      discount_type: discountType,
      discount_value: discountValue,
      duration,
      duration_in_months: durationInMonths,
      max_redemptions: maxRedemptions,
      expires_at: expiresAt,
      active: body.active === undefined ? true : Boolean(body.active),
    },
  };
}

router.get('/', async (req, res) => {
  try {
    const sb = getServiceClient();
    const [codesResult, redemptionsResult, usersResult] = await Promise.all([
      sb.from('promo_codes').select('*').order('created_at', { ascending: false }),
      sb.from('user_promo_codes').select('promo_code_id,user_id').limit(5000),
      sb.from('users').select('id,email,is_admin,is_test').limit(5000),
    ]);
    if (codesResult.error) throw codesResult.error;
    if (redemptionsResult.error) throw redemptionsResult.error;
    if (usersResult.error) throw usersResult.error;

    // A redemption by an admin or a test account is not a real redemption.
    const usersById = new Map((usersResult.data || []).map((u) => [u.id, u]));
    const counts = {};
    for (const r of redemptionsResult.data || []) {
      const u = usersById.get(r.user_id);
      if (u && isInternalAccount(u)) continue;
      counts[r.promo_code_id] = (counts[r.promo_code_id] || 0) + 1;
    }

    res.json({
      success: true,
      data: (codesResult.data || []).map((c) => shape(c, counts[c.id])),
    });
  } catch (error) {
    console.error('[AdminPromos] list failed:', error.message);
    res.status(500).json({ success: false, error: 'Failed to load promo codes' });
  }
});

router.post('/', async (req, res) => {
  try {
    const { error: invalid, value } = validateCreate(req.body || {});
    if (invalid) return res.status(400).json({ success: false, error: invalid });

    const sb = getServiceClient();

    const { data: existing, error: lookupError } = await sb
      .from('promo_codes')
      .select('id')
      .eq('code', value.code)
      .maybeSingle();
    if (lookupError) throw lookupError;
    if (existing) {
      return res.status(409).json({ success: false, error: `Code ${value.code} already exists` });
    }

    // Read-only: confirm the coupon exists. Never creates or mutates in Stripe.
    try {
      await getStripe().coupons.retrieve(value.stripe_coupon_id);
    } catch (stripeError) {
      console.error('[AdminPromos] stripe coupon lookup failed:', stripeError.message);
      return res.status(400).json({ success: false, error: 'Stripe coupon not found' });
    }

    const { data, error } = await sb.from('promo_codes').insert(value).select('*').single();
    if (error) {
      if (error.code === '23505') {
        return res.status(409).json({ success: false, error: 'Code or Stripe coupon already in use' });
      }
      throw error;
    }

    res.status(201).json({ success: true, data: shape(data, 0) });
  } catch (error) {
    console.error('[AdminPromos] create failed:', error.message);
    res.status(500).json({ success: false, error: 'Failed to create promo code' });
  }
});

router.patch('/:id', async (req, res) => {
  try {
    const body = req.body || {};
    const patch = {};

    if (body.active !== undefined) patch.active = Boolean(body.active);

    if (body.maxRedemptions !== undefined) {
      if (body.maxRedemptions === null) {
        patch.max_redemptions = null;
      } else {
        const n = parseInt(body.maxRedemptions, 10);
        if (!Number.isInteger(n) || n <= 0) {
          return res.status(400).json({ success: false, error: 'maxRedemptions must be a positive integer or null' });
        }
        patch.max_redemptions = n;
      }
    }

    if (body.expiresAt !== undefined) {
      if (body.expiresAt === null || body.expiresAt === '') {
        patch.expires_at = null;
      } else {
        const d = new Date(body.expiresAt);
        if (Number.isNaN(d.getTime())) {
          return res.status(400).json({ success: false, error: 'expiresAt must be an ISO date string or null' });
        }
        patch.expires_at = d.toISOString();
      }
    }

    if (!Object.keys(patch).length) {
      return res.status(400).json({ success: false, error: 'Nothing to update' });
    }
    patch.updated_at = new Date().toISOString();

    const sb = getServiceClient();
    const { data, error } = await sb
      .from('promo_codes')
      .update(patch)
      .eq('id', req.params.id)
      .select('*')
      .maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ success: false, error: 'Promo code not found' });

    res.json({ success: true, data: shape(data, undefined) });
  } catch (error) {
    console.error('[AdminPromos] update failed:', error.message);
    res.status(500).json({ success: false, error: 'Failed to update promo code' });
  }
});

module.exports = router;
