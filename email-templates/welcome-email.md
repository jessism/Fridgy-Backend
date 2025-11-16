# Welcome Email Template

## Template Settings in Postmark

- **Template Name**: Welcome to Trackabite
- **Template Alias**: `welcome` (⚠️ MUST match exactly!)
- **Subject**: Welcome to Trackabite - Let's Get Started!

## Template Variables

- `{{firstName}}` - User's first name
- `{{dashboardUrl}}` - Link to the dashboard

---

## HTML Template (Plain Text Style)

Copy and paste this into the **HTML** tab in Postmark:

```html
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif; line-height: 1.6; color: #000; max-width: 600px; margin: 0 auto; padding: 20px; background-color: #fff;">

  <div style="padding: 20px 0;">
    <p style="margin: 0 0 16px 0;">Hey {{firstName}},</p>

    <p style="margin: 0 0 16px 0;">I'm Jessie, the founder of Trackabite. And the little white and green genius you saw <strong>Bitee</strong>, is your new AI sous-chef. 🍳</p>

    <p style="margin: 0 0 16px 0;">We're so excited you're here. And we just wanted to say a big welcome aboard! 👋</p>

    <p style="margin: 0 0 16px 0;">You're officially one step away from making your food tracking and meal planning effortless (and dare I say… kind of fun).</p>

    <p style="margin: 0 0 16px 0;"><strong>Here's your quick start:</strong><br>
    Add your first item to your fridge:</p>

    <p style="margin: 0 0 16px 0;">Just tap "<strong>+ Add Item</strong>", snap it with your phone camera, and boom — you're good to go!</p>

    <p style="margin: 0 0 16px 0;">Once you add your items, Trackabite will help you see what's fresh, what's expiring soon, and how to waste less (and save more 💰).</p>

    <p style="margin: 0 0 16px 0;"><strong>Got it?</strong></p>

    <p style="margin: 0 0 16px 0;">Now go ahead and add your first item!</p>

    <p style="margin: 0 0 24px 0;"><a href="{{dashboardUrl}}" style="color: #0066cc; text-decoration: underline;">👉 Add Your First Item</a></p>

    <p style="margin: 0 0 16px 0;">You'll see just how easy (and oddly satisfying) it is to keep your fridge in check. 🥦</p>

    <p style="margin: 24px 0 16px 0; padding-top: 16px; border-top: 1px solid #eee;"><strong>P.S.</strong> If you get stuck or have an idea for a feature, just hit reply. I read every message and would love to hear from you.</p>

    <p style="margin: 24px 0 0 0;">Jessie<br>Trackabite Team</p>

  </div>

</body>
</html>
```

---

## Text Version

Copy and paste this into the **Text** tab in Postmark:

```
Hey {{firstName}},

I'm Jessie, the founder of Trackabite. And the little white and green genius you saw Bitee, is your new AI sous-chef. 🍳

We're so excited you're here. And we just wanted to say a big welcome aboard! 👋

You're officially one step away from making your food tracking and meal planning effortless (and dare I say… kind of fun).

HERE'S YOUR QUICK START:
Add your first item to your fridge:

Just tap "+ Add Item", snap it with your phone camera, and boom — you're good to go!

Once you add your items, Trackabite will help you see what's fresh, what's expiring soon, and how to waste less (and save more 💰).

Got it?

Now go ahead and add your first item!

Add Your First Item: {{dashboardUrl}}

You'll see just how easy (and oddly satisfying) it is to keep your fridge in check. 🥦

P.S. If you get stuck or have an idea for a feature, just hit reply. I read every message and would love to hear from you.

Jessie
Trackabite Team

---
Trackabite - Your AI-powered fridge inventory manager
```

---

## Setup Instructions

1. Go to [Postmark Templates](https://account.postmarkapp.com/servers/templates)
2. Click **"Create Template"**
3. Fill in:
   - **Template Name**: `Welcome to Trackabite`
   - **Template Alias**: `welcome` (MUST be exactly this!)
   - **Subject**: `Welcome to Trackabite - Let's Get Started!`
4. Paste the **HTML** content above into the HTML tab
5. Paste the **Text** content above into the Text tab
6. Click **"Save Template"**

---

## Testing

### Test from Postmark Dashboard:
1. Go to your template
2. Click **"Send Test Email"**
3. Fill in test data:
   ```json
   {
     "firstName": "Jessie",
     "dashboardUrl": "http://localhost:3001/home"
   }
   ```
4. Enter your email address
5. Click **Send**

### Test via Signup:
1. Sign up for a new account at localhost:3001
2. **Skip the paywall** (click X button)
3. Complete signup form with an @trackabite.app email
4. Check your inbox!

---

## Email Preview

**What the user sees:**

```
Subject: Welcome to Trackabite - Let's Get Started!

Hi Jessie,

Thanks for joining Trackabite! We're excited to help you reduce
food waste and save money.

Let's get started by adding your first items to your fridge inventory.

[Add Your First Items] (green button)

The Trackabite Team
```

---

Simple, clean, and actionable! 🚀
