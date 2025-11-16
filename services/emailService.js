const postmark = require('postmark');

// Initialize Postmark client
const client = new postmark.ServerClient(process.env.POSTMARK_API_KEY);

/**
 * Sends a trial start email to the user
 * @param {Object} user - User object with email and first_name
 * @param {Date} trialEndDate - When the trial ends
 * @returns {Promise<void>}
 */
async function sendTrialStartEmail(user, trialEndDate) {
  if (!process.env.EMAIL_ENABLED || process.env.EMAIL_ENABLED !== 'true') {
    console.log('[Email] Email sending is disabled');
    return;
  }

  try {
    console.log(`[Email] Sending trial start email to ${user.email}`);

    const result = await client.sendEmailWithTemplate({
      From: process.env.FROM_EMAIL,
      To: user.email,
      TemplateAlias: 'trial-start',
      TemplateModel: {
        firstName: user.first_name || 'there',
        trialEndDate: trialEndDate.toLocaleDateString('en-US', {
          weekday: 'long',
          year: 'numeric',
          month: 'long',
          day: 'numeric'
        }),
        dashboardUrl: `${process.env.FRONTEND_URL}/home`
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
 * @returns {Promise<void>}
 */
async function sendTrialEndingEmail(user, trialEndDate) {
  if (!process.env.EMAIL_ENABLED || process.env.EMAIL_ENABLED !== 'true') {
    console.log('[Email] Email sending is disabled');
    return;
  }

  try{
    console.log(`[Email] Sending trial ending email to ${user.email}`);

    const result = await client.sendEmailWithTemplate({
      From: process.env.FROM_EMAIL,
      To: user.email,
      TemplateAlias: 'trial-ending',
      TemplateModel: {
        firstName: user.first_name || 'there',
        trialEndDate: trialEndDate.toLocaleDateString('en-US', {
          weekday: 'long',
          year: 'numeric',
          month: 'long',
          day: 'numeric'
        }),
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
 * @returns {Promise<void>}
 */
async function sendPaymentSuccessEmail(user, amount, nextBillingDate) {
  if (!process.env.EMAIL_ENABLED || process.env.EMAIL_ENABLED !== 'true') {
    console.log('[Email] Email sending is disabled');
    return;
  }

  try {
    console.log(`[Email] Sending payment success email to ${user.email}`);

    const amountInDollars = (amount / 100).toFixed(2);

    const result = await client.sendEmailWithTemplate({
      From: process.env.FROM_EMAIL,
      To: user.email,
      TemplateAlias: 'payment-success',
      TemplateModel: {
        firstName: user.first_name || 'there',
        amount: `$${amountInDollars}`,
        nextBillingDate: nextBillingDate.toLocaleDateString('en-US', {
          year: 'numeric',
          month: 'long',
          day: 'numeric'
        }),
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

module.exports = {
  sendTrialStartEmail,
  sendTrialEndingEmail,
  sendPaymentSuccessEmail,
  sendWelcomeEmail
};
