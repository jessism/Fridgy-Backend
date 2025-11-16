# Postmark Email Setup Guide for Trackabite

This guide will walk you through setting up Postmark for sending trial notification emails.

---

## Step 1: Create Postmark Account

1. **Sign up for Postmark**: Go to [https://postmarkapp.com/](https://postmarkapp.com/)
2. **Choose a plan**:
   - **Free tier**: 100 emails/month (perfect for testing)
   - **Paid tier**: $15/month for 10,000 emails (for production)
3. **Verify your email address**

---

## Step 2: Set Up Sender Signature

Before you can send emails, you need to verify your sender email address.

### Option A: Single Email Address (Recommended for Testing)

1. Go to **Sender Signatures** in the Postmark dashboard
2. Click **Add Sender Signature**
3. Enter your sender email: `hello@trackabite.app`
4. Click **Send Verification Email**
5. Check your email inbox for `hello@trackabite.app` and click the verification link

### Option B: Domain Verification (Recommended for Production)

1. Go to **Sender Signatures** → **Domains**
2. Click **Add Domain**
3. Enter your domain: `trackabite.app`
4. Follow the instructions to add DNS records (DKIM, Return-Path)
5. Wait for DNS propagation (can take up to 24 hours)
6. Once verified, you can send from any email address at your domain

---

## Step 3: Get Your API Key

1. Go to your **Server** in the Postmark dashboard
2. Navigate to **API Tokens** tab
3. Copy your **Server API Token** (it should start with a random string)
4. Update your `/Backend/.env` file:
   ```bash
   POSTMARK_API_KEY=your_actual_api_key_here
   ```

---

## Step 4: Create Email Templates

You need to create 3 templates in Postmark. Here's how:

### Creating a Template

1. In Postmark dashboard, go to **Templates**
2. Click **Create Template**
3. Choose **Start from scratch** or use a layout
4. Fill in the template details (see below for each template)

---

## Template 1: Trial Start Email

**Template Settings:**
- **Template Name**: Trial Start Email
- **Template Alias**: `trial-start` (⚠️ MUST match exactly!)
- **Subject**: Welcome to your Trackabite Premium trial!

**Template Variables:**
- `{{firstName}}` - User's first name
- `{{trialEndDate}}` - When the trial ends (formatted date)
- `{{dashboardUrl}}` - Link to the app dashboard

**Suggested HTML Content:**

```html
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">

  <div style="background-color: #4fcf61; padding: 30px; text-align: center; border-radius: 10px 10px 0 0;">
    <h1 style="color: white; margin: 0; font-size: 28px;">🎉 Welcome to Trackabite Premium!</h1>
  </div>

  <div style="background-color: #f9f9f9; padding: 30px; border-radius: 0 0 10px 10px;">
    <p style="font-size: 18px; margin-top: 0;">Hi {{firstName}},</p>

    <p>Welcome to your <strong>7-day free trial</strong> of Trackabite Premium! We're excited to have you on board.</p>

    <div style="background-color: white; padding: 20px; border-left: 4px solid #4fcf61; margin: 20px 0;">
      <p style="margin: 0;"><strong>Your trial includes:</strong></p>
      <ul style="margin: 10px 0;">
        <li>✅ Unlimited grocery items</li>
        <li>✅ Unlimited uploaded recipes</li>
        <li>✅ Unlimited shopping lists</li>
        <li>✅ AI-powered food recognition</li>
        <li>✅ Recipe recommendations</li>
      </ul>
    </div>

    <p><strong>Trial ends:</strong> {{trialEndDate}}</p>

    <p>After your trial, your subscription will automatically continue at <strong>$4.99/month</strong>. You can cancel anytime before {{trialEndDate}} with no charge.</p>

    <div style="text-align: center; margin: 30px 0;">
      <a href="{{dashboardUrl}}" style="background-color: #4fcf61; color: white; padding: 15px 30px; text-decoration: none; border-radius: 5px; font-weight: bold; display: inline-block;">Start Using Premium →</a>
    </div>

    <p style="color: #666; font-size: 14px; margin-top: 30px;">
      Questions? Reply to this email or visit our support page.
    </p>
  </div>

  <div style="text-align: center; padding: 20px; color: #999; font-size: 12px;">
    <p>Trackabite - Your AI-powered fridge inventory manager</p>
    <p>You're receiving this email because you started a free trial.</p>
  </div>

</body>
</html>
```

**Text Version:**
```
Hi {{firstName}},

Welcome to your 7-day free trial of Trackabite Premium! We're excited to have you on board.

Your trial includes:
✅ Unlimited grocery items
✅ Unlimited uploaded recipes
✅ Unlimited shopping lists
✅ AI-powered food recognition
✅ Recipe recommendations

Trial ends: {{trialEndDate}}

After your trial, your subscription will automatically continue at $4.99/month. You can cancel anytime before {{trialEndDate}} with no charge.

Start using Premium: {{dashboardUrl}}

Questions? Reply to this email or visit our support page.

---
Trackabite - Your AI-powered fridge inventory manager
You're receiving this email because you started a free trial.
```

---

## Template 2: Trial Ending Email

**Template Settings:**
- **Template Name**: Trial Ending Reminder
- **Template Alias**: `trial-ending` (⚠️ MUST match exactly!)
- **Subject**: Your Trackabite trial ends tomorrow

**Template Variables:**
- `{{firstName}}` - User's first name
- `{{trialEndDate}}` - When the trial ends
- `{{billingUrl}}` - Link to billing/subscription page

**Suggested HTML Content:**

```html
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">

  <div style="background-color: #ff9800; padding: 30px; text-align: center; border-radius: 10px 10px 0 0;">
    <h1 style="color: white; margin: 0; font-size: 28px;">⏰ Your trial ends tomorrow!</h1>
  </div>

  <div style="background-color: #f9f9f9; padding: 30px; border-radius: 0 0 10px 10px;">
    <p style="font-size: 18px; margin-top: 0;">Hi {{firstName}},</p>

    <p>Just a friendly reminder that your <strong>Trackabite Premium trial ends on {{trialEndDate}}</strong>.</p>

    <div style="background-color: white; padding: 20px; border-left: 4px solid #ff9800; margin: 20px 0;">
      <p style="margin: 0;"><strong>What happens next?</strong></p>
      <ul style="margin: 10px 0;">
        <li>Tomorrow, you'll be charged <strong>$4.99</strong> for your first month</li>
        <li>You'll keep all your Premium features</li>
        <li>Your subscription continues month-to-month</li>
        <li>Cancel anytime from your billing page</li>
      </ul>
    </div>

    <p><strong>Want to cancel?</strong> No problem! Cancel before {{trialEndDate}} and you won't be charged.</p>

    <div style="text-align: center; margin: 30px 0;">
      <a href="{{billingUrl}}" style="background-color: #4fcf61; color: white; padding: 15px 30px; text-decoration: none; border-radius: 5px; font-weight: bold; display: inline-block; margin: 5px;">Manage Subscription →</a>
    </div>

    <p style="color: #666; font-size: 14px; margin-top: 30px;">
      Questions? We're here to help - just reply to this email.
    </p>
  </div>

  <div style="text-align: center; padding: 20px; color: #999; font-size: 12px;">
    <p>Trackabite - Your AI-powered fridge inventory manager</p>
  </div>

</body>
</html>
```

**Text Version:**
```
Hi {{firstName}},

Just a friendly reminder that your Trackabite Premium trial ends on {{trialEndDate}}.

What happens next?
• Tomorrow, you'll be charged $4.99 for your first month
• You'll keep all your Premium features
• Your subscription continues month-to-month
• Cancel anytime from your billing page

Want to cancel? No problem! Cancel before {{trialEndDate}} and you won't be charged.

Manage your subscription: {{billingUrl}}

Questions? We're here to help - just reply to this email.

---
Trackabite - Your AI-powered fridge inventory manager
```

---

## Template 3: Payment Success Email

**Template Settings:**
- **Template Name**: Payment Success
- **Template Alias**: `payment-success` (⚠️ MUST match exactly!)
- **Subject**: Payment received - Welcome to Trackabite Premium!

**Template Variables:**
- `{{firstName}}` - User's first name
- `{{amount}}` - Amount charged (e.g., "$4.99")
- `{{nextBillingDate}}` - Next billing date
- `{{billingUrl}}` - Link to billing page

**Suggested HTML Content:**

```html
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">

  <div style="background-color: #4fcf61; padding: 30px; text-align: center; border-radius: 10px 10px 0 0;">
    <h1 style="color: white; margin: 0; font-size: 28px;">✅ Payment Successful!</h1>
  </div>

  <div style="background-color: #f9f9f9; padding: 30px; border-radius: 0 0 10px 10px;">
    <p style="font-size: 18px; margin-top: 0;">Hi {{firstName}},</p>

    <p>Thank you for subscribing to <strong>Trackabite Premium</strong>! Your payment was processed successfully.</p>

    <div style="background-color: white; padding: 20px; border-radius: 5px; margin: 20px 0;">
      <table style="width: 100%; border-collapse: collapse;">
        <tr>
          <td style="padding: 10px; border-bottom: 1px solid #eee;"><strong>Amount charged:</strong></td>
          <td style="padding: 10px; border-bottom: 1px solid #eee; text-align: right;">{{amount}}</td>
        </tr>
        <tr>
          <td style="padding: 10px;"><strong>Next billing date:</strong></td>
          <td style="padding: 10px; text-align: right;">{{nextBillingDate}}</td>
        </tr>
      </table>
    </div>

    <p>You now have access to all Premium features:</p>
    <ul>
      <li>✅ Unlimited grocery items</li>
      <li>✅ Unlimited uploaded recipes</li>
      <li>✅ Unlimited shopping lists</li>
      <li>✅ AI-powered food recognition</li>
      <li>✅ Personalized recipe recommendations</li>
    </ul>

    <div style="text-align: center; margin: 30px 0;">
      <a href="{{billingUrl}}" style="background-color: #4fcf61; color: white; padding: 15px 30px; text-decoration: none; border-radius: 5px; font-weight: bold; display: inline-block;">View Billing Details →</a>
    </div>

    <p style="color: #666; font-size: 14px; margin-top: 30px;">
      Need help or have questions? Reply to this email anytime.
    </p>
  </div>

  <div style="text-align: center; padding: 20px; color: #999; font-size: 12px;">
    <p>Trackabite - Your AI-powered fridge inventory manager</p>
    <p>You can manage your subscription anytime from your account settings.</p>
  </div>

</body>
</html>
```

**Text Version:**
```
Hi {{firstName}},

Thank you for subscribing to Trackabite Premium! Your payment was processed successfully.

Payment Details:
Amount charged: {{amount}}
Next billing date: {{nextBillingDate}}

You now have access to all Premium features:
✅ Unlimited grocery items
✅ Unlimited uploaded recipes
✅ Unlimited shopping lists
✅ AI-powered food recognition
✅ Personalized recipe recommendations

View billing details: {{billingUrl}}

Need help or have questions? Reply to this email anytime.

---
Trackabite - Your AI-powered fridge inventory manager
You can manage your subscription anytime from your account settings.
```

---

## Step 5: Test Your Templates

### Option 1: Send Test Emails from Postmark Dashboard

1. Go to **Templates** in Postmark
2. Click on a template
3. Click **Send Test Email**
4. Fill in the test data:
   ```json
   {
     "firstName": "John",
     "trialEndDate": "November 22, 2025",
     "dashboardUrl": "http://localhost:3001/home",
     "billingUrl": "http://localhost:3001/subscription",
     "amount": "$4.99",
     "nextBillingDate": "December 22, 2025"
   }
   ```
5. Enter your test email address
6. Click **Send**

### Option 2: Test with Stripe Webhooks (Local Development)

1. **Install Stripe CLI**: [https://stripe.com/docs/stripe-cli](https://stripe.com/docs/stripe-cli)
2. **Login to Stripe**: `stripe login`
3. **Forward webhooks to localhost**:
   ```bash
   stripe listen --forward-to localhost:5000/api/webhooks/stripe
   ```
4. **Copy the webhook signing secret** and update your `.env`:
   ```bash
   STRIPE_WEBHOOK_SECRET=whsec_...
   ```
5. **Trigger a test subscription**:
   ```bash
   stripe trigger customer.subscription.created
   ```
6. Check your server logs and your email inbox!

---

## Step 6: Verify Environment Variables

Make sure your `/Backend/.env` file has all required variables:

```bash
# Postmark Configuration
POSTMARK_API_KEY=your_actual_postmark_api_key
FROM_EMAIL=hello@trackabite.app
SUPPORT_EMAIL=support@trackabite.app
EMAIL_ENABLED=true
SEND_TRIAL_START_EMAIL=true
SEND_TRIAL_ENDING_EMAIL=true
SEND_PAYMENT_SUCCESS_EMAIL=true

# Frontend URL (for email links)
FRONTEND_URL=http://localhost:3001
```

---

## Step 7: Restart Your Backend Server

```bash
cd Backend
npm run dev
```

You should see in the logs:
```
📧 Starting trial reminder scheduler...
📧 Trial reminder scheduler is running (runs daily at 9:00 AM)
```

---

## Troubleshooting

### Emails not sending?

1. **Check Postmark API key**:
   - Make sure `POSTMARK_API_KEY` is set correctly in `.env`
   - Verify the key works by sending a test email from Postmark dashboard

2. **Check sender signature**:
   - Verify `hello@trackabite.app` is verified in Postmark
   - Check for typos in the `FROM_EMAIL` environment variable

3. **Check template aliases**:
   - Template aliases MUST match exactly: `trial-start`, `trial-ending`, `payment-success`
   - Check for typos or extra spaces

4. **Check server logs**:
   - Look for `[Email]` prefixed log messages
   - Check for error messages from Postmark

5. **Check email feature flags**:
   - Ensure `EMAIL_ENABLED=true`
   - Ensure individual email flags are `true`

### Emails going to spam?

1. **Complete domain verification** (not just single email)
2. **Add SPF and DKIM records** to your domain DNS
3. **Warm up your sending domain** (start with small volume)
4. **Ask recipients to whitelist** `hello@trackabite.app`

---

## Production Checklist

Before going live:

- [ ] Domain fully verified in Postmark (SPF, DKIM, Return-Path)
- [ ] All 3 templates created with correct aliases
- [ ] Templates tested and rendering correctly
- [ ] Environment variables set in production
- [ ] Postmark account upgraded to paid plan (if needed)
- [ ] Sender reputation warmed up
- [ ] Unsubscribe link added to templates (optional but recommended)
- [ ] Privacy policy and terms linked in footer
- [ ] Webhook endpoint accessible from Stripe
- [ ] SSL certificate installed on domain

---

## Additional Resources

- **Postmark Documentation**: [https://postmarkapp.com/developer](https://postmarkapp.com/developer)
- **Postmark Templates Guide**: [https://postmarkapp.com/developer/user-guide/template-quickstart](https://postmarkapp.com/developer/user-guide/template-quickstart)
- **Stripe Webhooks Guide**: [https://stripe.com/docs/webhooks](https://stripe.com/docs/webhooks)
- **Stripe CLI**: [https://stripe.com/docs/stripe-cli](https://stripe.com/docs/stripe-cli)

---

## Support

If you encounter issues:
1. Check server logs for `[Email]` messages
2. Check Postmark Activity dashboard
3. Review webhook logs in Stripe Dashboard
4. Test with Stripe CLI locally

Happy emailing! 📧
