/**
 * Stripe Price Utility
 * Fetches and caches the subscription price from Stripe
 */

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

// Cache for price data (5 minute TTL)
let priceCache = null;
let priceCacheTime = 0;
const PRICE_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

/**
 * Get the current subscription price from Stripe
 * @returns {Promise<Object>} Price data with formatted amounts
 */
async function getSubscriptionPrice() {
  const now = Date.now();

  // Return cached price if still valid
  if (priceCache && (now - priceCacheTime) < PRICE_CACHE_TTL) {
    return priceCache;
  }

  try {
    const priceId = process.env.STRIPE_PRICE_ID;
    if (!priceId) {
      throw new Error('STRIPE_PRICE_ID not configured');
    }

    const price = await stripe.prices.retrieve(priceId);

    // Format the price
    const amount = price.unit_amount / 100; // Convert cents to dollars
    const formatted = `$${amount.toFixed(2)}`;
    const interval = price.recurring?.interval || 'month';

    // Cache the result
    priceCache = {
      price: price.unit_amount,
      amount,
      formatted,
      interval,
      formattedWithInterval: `${formatted}/${interval}`
    };
    priceCacheTime = now;

    return priceCache;
  } catch (error) {
    console.error('[StripePrice] Error fetching price from Stripe:', error.message);

    // Return fallback
    return {
      price: 333,
      amount: 3.33,
      formatted: '$3.33',
      interval: 'month',
      formattedWithInterval: '$3.33/month'
    };
  }
}

module.exports = { getSubscriptionPrice };
