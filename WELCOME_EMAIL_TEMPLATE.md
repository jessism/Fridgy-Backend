# Welcome Email Template for Postmark

## Template Settings

- **Template Name**: Welcome to Trackabite
- **Template Alias**: `welcome` (⚠️ MUST match exactly!)
- **Subject**: Welcome to Trackabite - Let's Get Started!

## Template Variables

- `{{firstName}}` - User's first name
- `{{dashboardUrl}}` - Link to the dashboard (http://localhost:3001/home)

## HTML Template

```html
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">

  <div style="background-color: #4fcf61; padding: 30px; text-align: center; border-radius: 10px 10px 0 0;">
    <h1 style="color: white; margin: 0; font-size: 28px;">Welcome to Trackabite!</h1>
  </div>

  <div style="background-color: #f9f9f9; padding: 40px 30px; border-radius: 0 0 10px 10px;">
    <p style="font-size: 18px; margin-top: 0;">Hi {{firstName}},</p>

    <p style="font-size: 16px;">Thanks for joining Trackabite! We're excited to help you reduce food waste and save money.</p>

    <p style="font-size: 16px;">Let's get started by adding your first items to your fridge inventory.</p>

    <div style="text-align: center; margin: 40px 0;">
      <a href="{{dashboardUrl}}" style="background-color: #4fcf61; color: white; padding: 16px 40px; text-decoration: none; border-radius: 8px; font-weight: bold; font-size: 16px; display: inline-block;">Add Your First Items</a>
    </div>

    <p style="margin-top: 40px; font-size: 14px; color: #666;">The Trackabite Team</p>

  </div>

  <div style="text-align: center; padding: 20px; color: #999; font-size: 12px;">
    <p style="margin: 5px 0;">Trackabite - Your AI-powered fridge inventory manager</p>
  </div>

</body>
</html>
```

## Text Version

```
Hi {{firstName}},

Thanks for joining Trackabite! We're excited to help you reduce food waste and save money.

Let's get started by adding your first items to your fridge inventory.

Add Your First Items: {{dashboardUrl}}

The Trackabite Team

---
Trackabite - Your AI-powered fridge inventory manager
```

## How to Create This Template in Postmark

1. Go to [Postmark Templates](https://account.postmarkapp.com/servers/templates)
2. Click **"Create Template"**
3. Choose **"Start from scratch"** or use a layout
4. Fill in the template details:
   - Template Name: `Welcome to Trackabite`
   - Template Alias: `welcome` (MUST be exactly this)
   - Subject: `Welcome to Trackabite - Let's Get Started!`
5. Paste the HTML content above into the **HTML** tab
6. Paste the text content above into the **Text** tab
7. Click **"Save Template"**

## Testing the Template

### Option 1: Test from Postmark Dashboard
1. Go to your template
2. Click **"Send Test Email"**
3. Fill in test data:
   ```json
   {
     "firstName": "Jessie",
     "dashboardUrl": "http://localhost:3001/home"
   }
   ```
4. Enter your test email
5. Click **Send**

### Option 2: Test via Signup
1. Sign up for a new account at localhost:3001
2. **Skip the paywall** (click X or continue free)
3. Complete signup form
4. Check your email inbox

## Expected Behavior

**When user starts trial:**
- ❌ Welcome email is NOT sent
- ✅ Trial start email is sent instead

**When user signs up without trial:**
- ✅ Welcome email is sent
- ❌ Trial start email is NOT sent

## Troubleshooting

**Email not sending?**
1. Check template alias is exactly `welcome` (case-sensitive)
2. Check `SEND_WELCOME_EMAIL=true` in `.env`
3. Check backend logs for `[Email]` messages
4. Verify Postmark account is approved (or test with @trackabite.app email)

**Email going to spam?**
1. Complete domain verification in Postmark
2. Add SPF and DKIM records
3. Ask recipients to whitelist hello@trackabite.app

---

Happy emailing! 📧
