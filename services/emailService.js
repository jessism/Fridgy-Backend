const postmark = require('postmark');
const moment = require('moment-timezone');

// Initialize Postmark client
const client = new postmark.ServerClient(process.env.POSTMARK_API_KEY);

/**
 * Format a date in the user's timezone
 * @param {Date} date - The date to format
 * @param {string} timezone - IANA timezone string (e.g., 'America/Los_Angeles')
 * @param {boolean} includeWeekday - Whether to include the weekday
 * @returns {string} Formatted date string
 */
function formatDateInTimezone(date, timezone = 'America/Los_Angeles', includeWeekday = true) {
  const format = includeWeekday ? 'dddd, MMMM D, YYYY' : 'MMMM D, YYYY';
  return moment(date).tz(timezone).format(format);
}

/**
 * Sends a trial start email to the user
 * @param {Object} user - User object with email and first_name
 * @param {Date} trialEndDate - When the trial ends
 * @param {string} timezone - User's timezone (IANA format)
 * @param {Object} pricingInfo - Pricing information (with discount if applicable)
 * @returns {Promise<void>}
 */
async function sendTrialStartEmail(user, trialEndDate, timezone = 'America/Los_Angeles', pricingInfo = null) {
  if (!process.env.EMAIL_ENABLED || process.env.EMAIL_ENABLED !== 'true') {
    console.log('[Email] Email sending is disabled');
    return;
  }

  try {
    console.log(`[Email] Sending trial start email to ${user.email} (timezone: ${timezone})`);

    const formattedDate = formatDateInTimezone(trialEndDate, timezone);
    console.log(`[Email] Trial end date formatted: ${formattedDate}`);

    // Default pricing if not provided
    const pricing = pricingInfo || {
      hasDiscount: false,
      regularAmount: '$4.99',
      firstChargeAmount: '$4.99',
      discountDescription: ''
    };

    console.log('[Email] Pricing info:', pricing);

    const result = await client.sendEmailWithTemplate({
      From: process.env.FROM_EMAIL,
      To: user.email,
      TemplateAlias: 'trial-start',
      TemplateModel: {
        firstName: user.first_name || 'there',
        trialEndDate: formattedDate,
        dashboardUrl: `${process.env.FRONTEND_URL}/home`,
        hasDiscount: pricing.hasDiscount,
        regularAmount: pricing.regularAmount,
        firstChargeAmount: pricing.firstChargeAmount,
        discountDescription: pricing.discountDescription
      }
    });

    console.log(`[Email] Trial start email sent successfully. MessageID: ${result.MessageID}`);
  } catch (error) {
    console.error('[Email] Failed to send trial start email:', error.message);
    // Don't throw - we don't want email failures to break the webhook
  }
}

/**
 * Sends a trial ending reminder email (1 day before trial ends)
 * @param {Object} user - User object with email and first_name
 * @param {Date} trialEndDate - When the trial ends
 * @param {string} timezone - User's timezone (IANA format)
 * @returns {Promise<void>}
 */
async function sendTrialEndingEmail(user, trialEndDate, timezone = 'America/Los_Angeles') {
  if (!process.env.EMAIL_ENABLED || process.env.EMAIL_ENABLED !== 'true') {
    console.log('[Email] Email sending is disabled');
    return;
  }

  try {
    console.log(`[Email] Sending trial ending email to ${user.email} (timezone: ${timezone})`);

    const formattedDate = formatDateInTimezone(trialEndDate, timezone);

    const result = await client.sendEmailWithTemplate({
      From: process.env.FROM_EMAIL,
      To: user.email,
      TemplateAlias: 'trial-ending',
      TemplateModel: {
        firstName: user.first_name || 'there',
        trialEndDate: formattedDate,
        billingUrl: `${process.env.FRONTEND_URL}/subscription`
      }
    });

    console.log(`[Email] Trial ending email sent successfully. MessageID: ${result.MessageID}`);
  } catch (error) {
    console.error('[Email] Failed to send trial ending email:', error.message);
    // Don't throw - we don't want email failures to break the scheduler
  }
}

/**
 * Sends a payment success email when trial converts to paid
 * @param {Object} user - User object with email and first_name
 * @param {number} amount - Amount charged in cents
 * @param {Date} nextBillingDate - Next billing date
 * @param {string} timezone - User's timezone (IANA format)
 * @returns {Promise<void>}
 */
async function sendPaymentSuccessEmail(user, amount, nextBillingDate, timezone = 'America/Los_Angeles') {
  if (!process.env.EMAIL_ENABLED || process.env.EMAIL_ENABLED !== 'true') {
    console.log('[Email] Email sending is disabled');
    return;
  }

  try {
    console.log(`[Email] Sending payment success email to ${user.email} (timezone: ${timezone})`);

    const amountInDollars = (amount / 100).toFixed(2);
    const formattedDate = formatDateInTimezone(nextBillingDate, timezone, false); // No weekday for billing date

    const result = await client.sendEmailWithTemplate({
      From: process.env.FROM_EMAIL,
      To: user.email,
      TemplateAlias: 'payment-success',
      TemplateModel: {
        firstName: user.first_name || 'there',
        amount: `$${amountInDollars}`,
        nextBillingDate: formattedDate,
        billingUrl: `${process.env.FRONTEND_URL}/subscription`
      }
    });

    console.log(`[Email] Payment success email sent successfully. MessageID: ${result.MessageID}`);
  } catch (error) {
    console.error('[Email] Failed to send payment success email:', error.message);
    // Don't throw - we don't want email failures to break the webhook
  }
}

/**
 * Sends a welcome email to new users (for free users who didn't start a trial)
 * @param {Object} user - User object with email and first_name
 * @returns {Promise<void>}
 */
async function sendWelcomeEmail(user) {
  if (!process.env.EMAIL_ENABLED || process.env.EMAIL_ENABLED !== 'true') {
    console.log('[Email] Email sending is disabled');
    return;
  }

  try {
    console.log(`[Email] Sending welcome email to ${user.email}`);

    const result = await client.sendEmailWithTemplate({
      From: process.env.FROM_EMAIL,
      To: user.email,
      TemplateAlias: 'welcome',
      TemplateModel: {
        firstName: user.first_name || 'there',
        dashboardUrl: `${process.env.FRONTEND_URL}/home`
      }
    });

    console.log(`[Email] Welcome email sent successfully. MessageID: ${result.MessageID}`);
  } catch (error) {
    console.error('[Email] Failed to send welcome email:', error.message);
    // Don't throw - we don't want email failures to break signup
  }
}

/**
 * Sends a daily expiry reminder email with items expiring soon
 * @param {Object} user - User object with email, first_name, and timezone
 * @param {Array} items - Array of expiring items grouped by urgency
 * @returns {Promise<void>}
 */
async function sendDailyExpiryEmail(user, items) {
  if (!process.env.EMAIL_ENABLED || process.env.EMAIL_ENABLED !== 'true') {
    console.log('[Email] Email sending is disabled');
    return;
  }

  try {
    console.log(`[Email] Sending daily expiry reminder to ${user.email}`);

    // Group items by urgency
    const today = new Date();
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);
    const thisWeek = new Date(today);
    thisWeek.setDate(thisWeek.getDate() + 7);

    const expiringToday = items.filter(item => {
      const expiryDate = new Date(item.expiration_date);
      return expiryDate.toDateString() === today.toDateString();
    });

    const expiringTomorrow = items.filter(item => {
      const expiryDate = new Date(item.expiration_date);
      return expiryDate.toDateString() === tomorrow.toDateString();
    });

    const expiringThisWeek = items.filter(item => {
      const expiryDate = new Date(item.expiration_date);
      return expiryDate > tomorrow && expiryDate <= thisWeek;
    });

    const totalCount = items.length;

    // Format items for email template
    const formatItems = (itemList) => itemList.map(item => ({
      name: item.item_name,
      quantity: item.quantity || 1,
      date: formatDateInTimezone(new Date(item.expiration_date), user.timezone || 'America/Los_Angeles', false),
      emoji: getCategoryEmoji(item.category)
    }));

    const result = await client.sendEmailWithTemplate({
      From: process.env.FROM_EMAIL,
      To: user.email,
      TemplateAlias: 'daily-expiry-reminder',
      TemplateModel: {
        firstName: user.first_name || 'there',
        totalCount,
        hasExpiringToday: expiringToday.length > 0,
        expiringToday: formatItems(expiringToday),
        hasExpiringTomorrow: expiringTomorrow.length > 0,
        expiringTomorrow: formatItems(expiringTomorrow),
        hasExpiringThisWeek: expiringThisWeek.length > 0,
        expiringThisWeek: formatItems(expiringThisWeek),
        recipesUrl: `${process.env.FRONTEND_URL}/recipes`,
        inventoryUrl: `${process.env.FRONTEND_URL}/inventory`
      }
    });

    console.log(`[Email] Daily expiry email sent successfully. MessageID: ${result.MessageID}`);
  } catch (error) {
    console.error('[Email] Failed to send daily expiry email:', error.message);
    // Don't throw - we don't want email failures to break the scheduler
  }
}

/**
 * Sends a weekly expiry summary email (sent on Sundays)
 * @param {Object} user - User object with email, first_name, and timezone
 * @param {Array} items - Array of all items expiring this week
 * @returns {Promise<void>}
 */
async function sendWeeklyExpiryEmail(user, items) {
  if (!process.env.EMAIL_ENABLED || process.env.EMAIL_ENABLED !== 'true') {
    console.log('[Email] Email sending is disabled');
    return;
  }

  try {
    console.log(`[Email] Sending weekly expiry summary to ${user.email}`);

    // Group items by day of the week
    const today = new Date();
    const itemsByDay = {};

    // Initialize days of the week
    const daysOfWeek = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
    daysOfWeek.forEach(day => {
      itemsByDay[day] = [];
    });

    items.forEach(item => {
      const expiryDate = new Date(item.expiration_date);
      const dayName = moment(expiryDate).tz(user.timezone || 'America/Los_Angeles').format('dddd');

      if (itemsByDay[dayName]) {
        itemsByDay[dayName].push({
          name: item.item_name,
          quantity: item.quantity || 1,
          date: formatDateInTimezone(expiryDate, user.timezone || 'America/Los_Angeles', false),
          emoji: getCategoryEmoji(item.category)
        });
      }
    });

    // Create array for template (only include days with items)
    const weekSchedule = daysOfWeek.map(day => ({
      day,
      hasItems: itemsByDay[day].length > 0,
      items: itemsByDay[day],
      count: itemsByDay[day].length
    })).filter(dayObj => dayObj.hasItems);

    const totalCount = items.length;

    const result = await client.sendEmailWithTemplate({
      From: process.env.FROM_EMAIL,
      To: user.email,
      TemplateAlias: 'weekly-expiry-summary',
      TemplateModel: {
        firstName: user.first_name || 'there',
        totalCount,
        weekSchedule,
        mealPlanUrl: `${process.env.FRONTEND_URL}/meal-plans`,
        recipesUrl: `${process.env.FRONTEND_URL}/recipes`,
        inventoryUrl: `${process.env.FRONTEND_URL}/inventory`
      }
    });

    console.log(`[Email] Weekly expiry email sent successfully. MessageID: ${result.MessageID}`);
  } catch (error) {
    console.error('[Email] Failed to send weekly expiry email:', error.message);
    // Don't throw - we don't want email failures to break the scheduler
  }
}

/**
 * Sends tips and updates email (manually triggered)
 * @param {Object} user - User object with email and first_name
 * @param {Object} content - Content object with subject, heading, body, ctaText, ctaUrl
 * @returns {Promise<void>}
 */
async function sendTipsAndUpdatesEmail(user, content) {
  if (!process.env.EMAIL_ENABLED || process.env.EMAIL_ENABLED !== 'true') {
    console.log('[Email] Email sending is disabled');
    return;
  }

  try {
    console.log(`[Email] Sending tips & updates email to ${user.email}`);

    const result = await client.sendEmailWithTemplate({
      From: process.env.FROM_EMAIL,
      To: user.email,
      TemplateAlias: 'tips-and-updates',
      TemplateModel: {
        firstName: user.first_name || 'there',
        subject: content.subject || '💡 Tip from Trackabite',
        heading: content.heading || 'A helpful tip for you!',
        body: content.body || '',
        ctaText: content.ctaText || 'Learn More',
        ctaUrl: content.ctaUrl || `${process.env.FRONTEND_URL}/home`,
        hasImage: !!content.imageUrl,
        imageUrl: content.imageUrl || ''
      }
    });

    console.log(`[Email] Tips & updates email sent successfully. MessageID: ${result.MessageID}`);
  } catch (error) {
    console.error('[Email] Failed to send tips & updates email:', error.message);
    // Don't throw - we don't want email failures to break the send
  }
}

/**
 * Helper function to get emoji for food category
 * @param {string} category - Food category
 * @returns {string} Emoji character
 */
function getCategoryEmoji(category) {
  const emojiMap = {
    'dairy': '🥛',
    'produce': '🥬',
    'meat': '🥩',
    'fruit': '🍎',
    'vegetables': '🥕',
    'grains': '🌾',
    'bakery': '🍞',
    'seafood': '🐟',
    'frozen': '🧊',
    'beverages': '🥤',
    'snacks': '🍿',
    'condiments': '🧂',
    'other': '🍽️'
  };

  return emojiMap[category?.toLowerCase()] || '🍽️';
}

/**
 * Sends a subscription cancellation confirmation email
 * @param {Object} user - User object with email and first_name
 * @param {Date} accessUntilDate - When Pro access ends (current_period_end)
 * @param {string} timezone - User's timezone (IANA format)
 * @returns {Promise<void>}
 */
async function sendCancellationEmail(user, accessUntilDate, timezone = 'America/Los_Angeles') {
  if (!process.env.EMAIL_ENABLED || process.env.EMAIL_ENABLED !== 'true') {
    console.log('[Email] Email sending is disabled');
    return;
  }

  try {
    console.log(`[Email] Sending cancellation email to ${user.email} (timezone: ${timezone})`);

    const formattedDate = formatDateInTimezone(accessUntilDate, timezone);
    console.log(`[Email] Access until date formatted: ${formattedDate}`);

    const result = await client.sendEmailWithTemplate({
      From: process.env.FROM_EMAIL,
      To: user.email,
      TemplateAlias: 'subscription-cancelled',
      TemplateModel: {
        firstName: user.first_name || 'there',
        accessUntilDate: formattedDate,
        subscriptionUrl: `${process.env.FRONTEND_URL}/subscription`
      }
    });

    console.log(`[Email] Cancellation email sent successfully. MessageID: ${result.MessageID}`);
  } catch (error) {
    console.error('[Email] Failed to send cancellation email:', error.message);
    // Don't throw - we don't want email failures to break the cancellation flow
  }
}

module.exports = {
  sendTrialStartEmail,
  sendTrialEndingEmail,
  sendPaymentSuccessEmail,
  sendWelcomeEmail,
  sendDailyExpiryEmail,
  sendWeeklyExpiryEmail,
  sendTipsAndUpdatesEmail,
  sendCancellationEmail
};
