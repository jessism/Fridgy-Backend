# Postmark Email Templates - Setup Guide

This document contains all email templates for the Trackabite expiry notification system. You need to create these templates in your Postmark dashboard.

## ⚠️ CRITICAL: Postmark Uses {{#each}} for Arrays!

**Postmark uses Mustachio templating**, NOT standard Mustache. To iterate over arrays, you MUST use:

```html
{{#each arrayName}}
  {{propertyName}}
{{/each}}
```

**NOT** `{{#arrayName}}...{{/arrayName}}` (standard Mustache - won't work!)

This is the most common reason items don't show in templates.

## How to Create Templates in Postmark

1. Log in to your Postmark account (https://account.postmarkapp.com)
2. Go to your Server → Templates
3. Click "Create Template"
4. Choose "Create Template from Scratch"
5. Enter the Template Alias exactly as shown below
6. Copy and paste the HTML and Text versions
7. Set up the template variables
8. Test the template
9. Save and activate

---

## Template 1: Daily Expiry Reminder

**Template Alias:** `daily-expiry-reminder`

**Subject:** `🍅 {{firstName}}, you have {{totalCount}} items expiring soon!`

**Template Variables:**
- `firstName` (string)
- `totalCount` (number)
- `hasExpiringToday` (boolean)
- `expiringToday` (array of objects: `{name, quantity, date, emoji}`)
- `hasExpiringTomorrow` (boolean)
- `expiringTomorrow` (array)
- `hasExpiringThisWeek` (boolean)
- `expiringThisWeek` (array)
- `recipesUrl` (string)
- `inventoryUrl` (string)

**⚠️ CRITICAL - Postmark Template Engine:**
Postmark uses **Mustachio** templating. When creating the template:
1. Use the **Layout** template type (not Legacy)
2. Arrays MUST use `{{#each arrayName}}...{{/each}}` (NOT `{{#arrayName}}`)
3. When nested inside conditionals, use `{{#each ../arrayName}}` to access parent scope
4. Make sure to test with the exact JSON structure provided below

**See `POSTMARK_TROUBLESHOOTING_Nov22.md` for detailed syntax guide and common issues.**

### HTML Version:

```html
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Food Expiring Soon</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
      line-height: 1.6;
      color: #333;
      max-width: 600px;
      margin: 0 auto;
      padding: 20px;
      background-color: #f5f5f5;
    }
    .container {
      background-color: #ffffff;
      border-radius: 8px;
      padding: 30px;
      box-shadow: 0 2px 4px rgba(0,0,0,0.1);
    }
    .header {
      text-align: center;
      padding-bottom: 20px;
      border-bottom: 2px solid #4fcf61;
    }
    .logo {
      font-size: 24px;
      font-weight: bold;
      color: #4fcf61;
    }
    h1 {
      color: #333;
      font-size: 24px;
      margin-bottom: 10px;
    }
    .greeting {
      font-size: 18px;
      color: #666;
      margin-bottom: 20px;
    }
    .urgency-section {
      margin: 25px 0;
      padding: 15px;
      border-radius: 6px;
    }
    .urgent {
      background-color: #ffebee;
      border-left: 4px solid #f44336;
    }
    .soon {
      background-color: #fff3e0;
      border-left: 4px solid #ff9800;
    }
    .this-week {
      background-color: #e8f5e9;
      border-left: 4px solid #4caf50;
    }
    .section-title {
      font-weight: bold;
      font-size: 16px;
      margin-bottom: 10px;
    }
    .item {
      display: flex;
      justify-content: space-between;
      padding: 8px 0;
      border-bottom: 1px solid #eee;
    }
    .item:last-child {
      border-bottom: none;
    }
    .item-name {
      font-weight: 500;
    }
    .cta-button {
      display: inline-block;
      padding: 14px 32px;
      background-color: #4fcf61;
      color: #ffffff !important;
      text-decoration: none;
      border-radius: 6px;
      font-weight: bold;
      font-size: 16px;
      text-align: center;
      margin: 20px 0;
    }
    .cta-button:hover {
      background-color: #45b856;
    }
    .cta-container {
      text-align: center;
      margin: 30px 0;
    }
    .secondary-link {
      color: #4fcf61;
      text-decoration: none;
      font-size: 14px;
    }
    .footer {
      margin-top: 30px;
      padding-top: 20px;
      border-top: 1px solid #eee;
      text-align: center;
      font-size: 12px;
      color: #999;
    }
    .footer a {
      color: #4fcf61;
      text-decoration: none;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <div class="logo">🍽️ Trackabite</div>
    </div>

    <div class="greeting">
      Hey {{firstName}}! 👋
    </div>

    <p>Quick heads up for today - you have <strong>{{totalCount}} items</strong> that need your attention:</p>

    {{#hasExpiringToday}}
    <div class="urgency-section urgent">
      <div class="section-title">⚠️ EXPIRING TODAY</div>
      {{#each ../expiringToday}}
      <div class="item">
        <span><span class="item-name">{{name}}</span> ({{quantity}})</span>
        <span>{{date}}</span>
      </div>
      {{/each}}
    </div>
    {{/hasExpiringToday}}

    {{#hasExpiringTomorrow}}
    <div class="urgency-section soon">
      <div class="section-title">⏰ EXPIRING TOMORROW</div>
      {{#each ../expiringTomorrow}}
      <div class="item">
        <span><span class="item-name">{{name}}</span> ({{quantity}})</span>
        <span>{{date}}</span>
      </div>
      {{/each}}
    </div>
    {{/hasExpiringTomorrow}}

    {{#hasExpiringThisWeek}}
    <div class="urgency-section this-week">
      <div class="section-title">📅 EXPIRING THIS WEEK</div>
      {{#each ../expiringThisWeek}}
      <div class="item">
        <span><span class="item-name">{{name}}</span> ({{quantity}})</span>
        <span>{{date}}</span>
      </div>
      {{/each}}
    </div>
    {{/hasExpiringThisWeek}}

    <div class="cta-container">
      <a href="{{recipesUrl}}" class="cta-button">🍳 Get Recipe Ideas Now</a>
      <br><br>
      <a href="{{inventoryUrl}}" class="secondary-link">View My Inventory →</a>
    </div>

    <p style="color: #666; font-size: 14px;">
      Our AI can create personalized recipes using these exact ingredients. Don't let good food go to waste!
    </p>

    <div class="footer">
      <p>Sent with 💚 from Trackabite</p>
      <p>
        <a href="{{unsubscribeUrl}}">Email Preferences</a> |
        <a href="https://trackabite.app">Visit Trackabite</a>
      </p>
    </div>
  </div>
</body>
</html>
```

### Text Version:

```
Hey {{firstName}}!

Quick heads up - you have {{totalCount}} items expiring soon:

{{#hasExpiringToday}}
⚠️ EXPIRING TODAY:
{{#each ../expiringToday}}
- {{name}} ({{quantity}}) - {{date}}
{{/each}}

{{/hasExpiringToday}}
{{#hasExpiringTomorrow}}
⏰ EXPIRING TOMORROW:
{{#each ../expiringTomorrow}}
- {{name}} ({{quantity}}) - {{date}}
{{/each}}

{{/hasExpiringTomorrow}}
{{#hasExpiringThisWeek}}
📅 EXPIRING THIS WEEK:
{{#each ../expiringThisWeek}}
- {{name}} ({{quantity}}) - {{date}}
{{/each}}

{{/hasExpiringThisWeek}}

🍳 GET RECIPE IDEAS: {{recipesUrl}}

Our AI can create personalized recipes using these exact ingredients!

View your inventory: {{inventoryUrl}}

---
Sent with 💚 from Trackabite
Manage email preferences: {{unsubscribeUrl}}
```

### 🐛 Troubleshooting: Items Not Showing?

If you see the colored sections but NO ITEMS inside them:

**Problem:** The array iteration blocks `{{#expiringToday}}...{{/expiringToday}}` aren't rendering items.

**Solution 1: Verify Template Type**
- In Postmark, make sure you selected **"Layout"** template (NOT "Legacy")
- Layout templates use modern Mustache syntax that supports arrays

**Solution 2: Check Your Test Data Format**
Make sure you're pasting the JSON in the **"Test Data"** section (not "Template Model"):
```json
{
  "firstName": "Alex",
  "totalCount": 5,
  "hasExpiringToday": true,
  "expiringToday": [
    {"name": "Spinach", "quantity": 1, "date": "Nov 20", "emoji": "🥬"},
    {"name": "Milk", "quantity": 1, "date": "Nov 20", "emoji": "🥛"}
  ],
  "recipesUrl": "https://trackabite.app/recipes",
  "inventoryUrl": "https://trackabite.app/inventory",
  "unsubscribeUrl": "https://trackabite.app/settings"
}
```

**Solution 3: ⚠️ USE {{#each}} NOT {{#arrayName}}**
**THIS IS THE FIX!** Postmark uses Mustachio templating, which requires `{{#each}}` for arrays:

**WRONG** ❌:
```html
{{#expiringToday}}
  <div>{{name}}</div>
{{/expiringToday}}
```

**CORRECT** ✅:
```html
{{#each expiringToday}}
  <div>{{name}}</div>
{{/each}}
```

Your HTML should have:
```html
{{#each ../expiringToday}}
<div class="item">
  <span><span class="item-name">{{name}}</span> ({{quantity}})</span>
  <span>{{date}}</span>
</div>
{{/each}}
```

**Note:** The `../` is CRITICAL when nested inside conditionals like `{{#hasExpiringToday}}`.

**Solution 4: Simplified Debug Template**
If still not working, try this minimal version first:
```html
{{#hasExpiringToday}}
<div style="background: #ffebee; padding: 15px; margin: 10px 0;">
  <strong>⚠️ EXPIRING TODAY</strong>
  {{#each ../expiringToday}}
    <div style="padding: 5px 0;">{{name}} ({{quantity}}) - {{date}}</div>
  {{/each}}
</div>
{{/hasExpiringToday}}
```

If the simplified version works, then gradually add back the full styling.

---

## Template 2: Weekly Expiry Summary

**Template Alias:** `weekly-expiry-summary`

**Subject:** `📅 Your week ahead: {{totalCount}} items to plan for`

**Template Variables:**
- `firstName` (string)
- `totalCount` (number)
- `weekSchedule` (array of objects: `{day, hasItems, items: [{name, quantity, date, emoji}], count}`)
- `mealPlanUrl` (string)
- `recipesUrl` (string)
- `inventoryUrl` (string)

### HTML Version:

```html
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Your Weekly Food Plan</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
      line-height: 1.6;
      color: #333;
      max-width: 600px;
      margin: 0 auto;
      padding: 20px;
      background-color: #f5f5f5;
    }
    .container {
      background-color: #ffffff;
      border-radius: 8px;
      padding: 30px;
      box-shadow: 0 2px 4px rgba(0,0,0,0.1);
    }
    .header {
      text-align: center;
      padding-bottom: 20px;
      border-bottom: 2px solid #4fcf61;
    }
    .logo {
      font-size: 24px;
      font-weight: bold;
      color: #4fcf61;
    }
    .greeting {
      font-size: 18px;
      color: #666;
      margin: 20px 0;
    }
    .day-section {
      margin: 20px 0;
      padding: 15px;
      background-color: #f9f9f9;
      border-radius: 6px;
      border-left: 4px solid #4fcf61;
    }
    .day-title {
      font-weight: bold;
      font-size: 16px;
      color: #333;
      margin-bottom: 10px;
    }
    .item {
      padding: 6px 0;
      display: flex;
      justify-content: space-between;
    }
    .item-emoji {
      margin-right: 8px;
    }
    .cta-button {
      display: inline-block;
      padding: 14px 32px;
      background-color: #4fcf61;
      color: #ffffff !important;
      text-decoration: none;
      border-radius: 6px;
      font-weight: bold;
      font-size: 16px;
      margin: 10px 5px;
    }
    .cta-container {
      text-align: center;
      margin: 30px 0;
    }
    .footer {
      margin-top: 30px;
      padding-top: 20px;
      border-top: 1px solid #eee;
      text-align: center;
      font-size: 12px;
      color: #999;
    }
    .footer a {
      color: #4fcf61;
      text-decoration: none;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <div class="logo">🍽️ Trackabite</div>
    </div>

    <div class="greeting">
      Hey {{firstName}}! ☕
    </div>

    <p>Here's your food inventory for the week ahead. You have <strong>{{totalCount}} items</strong> to use up:</p>

    {{#each weekSchedule}}
    <div class="day-section">
      <div class="day-title">{{day}} ({{count}} items)</div>
      {{#each items}}
      <div class="item">
        <span><span class="item-emoji">{{emoji}}</span>{{name}} ({{quantity}})</span>
      </div>
      {{/each}}
    </div>
    {{/each}}

    <div class="cta-container">
      <a href="{{mealPlanUrl}}" class="cta-button">🗓️ Plan Your Meals</a>
      <a href="{{recipesUrl}}" class="cta-button">🍳 Get Recipes</a>
      <br><br>
      <a href="{{inventoryUrl}}" style="color: #4fcf61; text-decoration: none;">View Full Inventory →</a>
    </div>

    <p style="color: #666; font-size: 14px;">
      💡 Tip: Planning your meals ahead saves time and reduces food waste. Our AI can help you create a perfect week of meals!
    </p>

    <div class="footer">
      <p>Sent with 💚 from Trackabite</p>
      <p>
        <a href="{{unsubscribeUrl}}">Email Preferences</a> |
        <a href="https://trackabite.app">Visit Trackabite</a>
      </p>
    </div>
  </div>
</body>
</html>
```

### Text Version:

```
Hey {{firstName}}! ☕

Here's your food inventory for the week ahead. You have {{totalCount}} items to use up:

{{#each weekSchedule}}
{{day}} ({{count}} items):
{{#each items}}
- {{emoji}} {{name}} ({{quantity}})
{{/each}}

{{/each}}

🗓️ PLAN YOUR MEALS: {{mealPlanUrl}}
🍳 GET RECIPES: {{recipesUrl}}

💡 Tip: Planning your meals ahead saves time and reduces food waste!

View your full inventory: {{inventoryUrl}}

---
Sent with 💚 from Trackabite
Manage email preferences: {{unsubscribeUrl}}
```

---

## Template 3: Tips & Updates

**Template Alias:** `tips-and-updates`

**Subject:** `{{subject}}`

**Template Variables:**
- `firstName` (string)
- `subject` (string)
- `heading` (string)
- `body` (string/HTML)
- `ctaText` (string)
- `ctaUrl` (string)
- `hasImage` (boolean)
- `imageUrl` (string)

### HTML Version:

```html
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>{{subject}}</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
      line-height: 1.6;
      color: #333;
      max-width: 600px;
      margin: 0 auto;
      padding: 20px;
      background-color: #f5f5f5;
    }
    .container {
      background-color: #ffffff;
      border-radius: 8px;
      padding: 30px;
      box-shadow: 0 2px 4px rgba(0,0,0,0.1);
    }
    .header {
      text-align: center;
      padding-bottom: 20px;
      border-bottom: 2px solid #4fcf61;
    }
    .logo {
      font-size: 24px;
      font-weight: bold;
      color: #4fcf61;
    }
    h1 {
      color: #333;
      font-size: 24px;
      margin: 20px 0;
    }
    .body-content {
      margin: 25px 0;
      font-size: 15px;
      line-height: 1.8;
    }
    .feature-image {
      width: 100%;
      max-width: 500px;
      height: auto;
      border-radius: 8px;
      margin: 20px 0;
    }
    .cta-button {
      display: inline-block;
      padding: 14px 32px;
      background-color: #4fcf61;
      color: #ffffff !important;
      text-decoration: none;
      border-radius: 6px;
      font-weight: bold;
      font-size: 16px;
      margin: 20px 0;
    }
    .cta-container {
      text-align: center;
      margin: 30px 0;
    }
    .footer {
      margin-top: 30px;
      padding-top: 20px;
      border-top: 1px solid #eee;
      text-align: center;
      font-size: 12px;
      color: #999;
    }
    .footer a {
      color: #4fcf61;
      text-decoration: none;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <div class="logo">🍽️ Trackabite</div>
    </div>

    <h1>{{heading}}</h1>

    <p>Hey {{firstName}}! 👋</p>

    {{#hasImage}}
    <img src="{{imageUrl}}" alt="Feature image" class="feature-image">
    {{/hasImage}}

    <div class="body-content">
      {{{body}}}
    </div>

    <div class="cta-container">
      <a href="{{ctaUrl}}" class="cta-button">{{ctaText}}</a>
    </div>

    <div class="footer">
      <p>Sent with 💚 from Trackabite</p>
      <p>
        <a href="{{unsubscribeUrl}}">Email Preferences</a> |
        <a href="https://trackabite.app">Visit Trackabite</a>
      </p>
    </div>
  </div>
</body>
</html>
```

### Text Version:

```
{{heading}}

Hey {{firstName}}!

{{body}}

{{ctaText}}: {{ctaUrl}}

---
Sent with 💚 from Trackabite
Manage email preferences: {{unsubscribeUrl}}
```

---

## Testing Your Templates

After creating each template in Postmark, test them with sample data:

### Test Data for daily-expiry-reminder:
```json
{
  "firstName": "Alex",
  "totalCount": 5,
  "hasExpiringToday": true,
  "expiringToday": [
    {"name": "Spinach", "quantity": 1, "date": "Nov 20", "emoji": "🥬"},
    {"name": "Milk", "quantity": 1, "date": "Nov 20", "emoji": "🥛"}
  ],
  "hasExpiringTomorrow": true,
  "expiringTomorrow": [
    {"name": "Tomatoes", "quantity": 2, "date": "Nov 21", "emoji": "🍅"}
  ],
  "hasExpiringThisWeek": true,
  "expiringThisWeek": [
    {"name": "Cheese", "quantity": 1, "date": "Nov 25", "emoji": "🧀"},
    {"name": "Bread", "quantity": 1, "date": "Nov 26", "emoji": "🍞"}
  ],
  "recipesUrl": "https://trackabite.app/recipes",
  "inventoryUrl": "https://trackabite.app/inventory",
  "unsubscribeUrl": "https://trackabite.app/settings"
}
```

### Test Data for weekly-expiry-summary:
```json
{
  "firstName": "Alex",
  "totalCount": 8,
  "weekSchedule": [
    {
      "day": "Monday",
      "hasItems": true,
      "count": 2,
      "items": [
        {"name": "Spinach", "quantity": 1, "emoji": "🥬"},
        {"name": "Milk", "quantity": 1, "emoji": "🥛"}
      ]
    },
    {
      "day": "Tuesday",
      "hasItems": true,
      "count": 1,
      "items": [
        {"name": "Tomatoes", "quantity": 2, "emoji": "🍅"}
      ]
    }
  ],
  "mealPlanUrl": "https://trackabite.app/meal-plans",
  "recipesUrl": "https://trackabite.app/recipes",
  "inventoryUrl": "https://trackabite.app/inventory",
  "unsubscribeUrl": "https://trackabite.app/settings"
}
```

### Test Data for tips-and-updates:
```json
{
  "firstName": "Alex",
  "subject": "💡 Never waste bread again!",
  "heading": "Freeze Your Bread Properly",
  "body": "<p>Did you know that bread freezes beautifully? Here's how to do it right:</p><ul><li>Slice before freezing for easy access</li><li>Use airtight freezer bags</li><li>Toast frozen slices directly - no thawing needed!</li></ul><p>This simple trick can extend your bread's life by months!</p>",
  "ctaText": "See More Tips",
  "ctaUrl": "https://trackabite.app/tips",
  "hasImage": false,
  "imageUrl": "",
  "unsubscribeUrl": "https://trackabite.app/settings"
}
```

---

## Next Steps

1. **Create all 3 templates in Postmark** using the exact template aliases
2. **Test each template** with the sample data provided
3. **Update .env file** to enable emails:
   ```
   EMAIL_ENABLED=true
   ```
4. **Run the database migration** to add email preference columns:
   - Go to Supabase Dashboard → SQL Editor
   - Run the migration file: `/Backend/migrations/020_add_email_preferences.sql`
5. **Restart your backend server** to load the new email scheduler

---

## Troubleshooting

**Template not sending?**
- Check that `EMAIL_ENABLED=true` in your .env
- Verify `POSTMARK_API_KEY` is set correctly
- Check that template aliases match exactly (case-sensitive!)
- Look for errors in server logs

**Email looks broken?**
- Test in Postmark's preview tool first
- Check that all template variables are being passed correctly
- Verify HTML is valid (no unclosed tags)

**Users not receiving emails?**
- Check spam folder
- Verify email addresses are correct
- Check Postmark activity log for delivery status
- Ensure database migration was run successfully
