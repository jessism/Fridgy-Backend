# Postmark Email Template Troubleshooting Guide
**Date:** November 22, 2025
**Issue:** Items not appearing in Postmark email templates
**Status:** ✅ SOLVED

---

## 🐛 The Problem

When creating email templates in Postmark for the Trackabite expiry notification system, **items from arrays were not rendering** in the email preview, even though:
- The test data was correctly formatted
- The template syntax looked correct
- The sections (colored boxes) were appearing
- All other template variables (firstName, totalCount, etc.) were working

**What we saw:**
```
✅ Subject: "Alex, you have 5 items expiring soon!"
✅ Greeting: "Hey Alex!"
✅ Section headers: "EXPIRING TODAY", "EXPIRING TOMORROW"
❌ No items showing inside the sections (empty boxes)
```

---

## 🔍 Root Cause Analysis

### Issue #1: Wrong Templating Syntax
**Postmark uses Mustachio**, not standard Mustache templating!

❌ **Standard Mustache (doesn't work in Postmark):**
```html
{{#arrayName}}
  <div>{{name}}</div>
{{/arrayName}}
```

✅ **Mustachio (Postmark's syntax):**
```html
{{#each arrayName}}
  <div>{{name}}</div>
{{/each}}
```

**Key Difference:** Postmark requires the `{{#each}}` keyword to iterate over arrays.

### Issue #2: Scope Access Problem
Even after using `{{#each}}`, items still weren't appearing because of **nested scope issues**.

❌ **Nested without parent scope access (doesn't work):**
```html
{{#hasExpiringToday}}
  {{#each expiringToday}}
    <div>{{name}}</div>
  {{/each}}
{{/hasExpiringToday}}
```

When you nest `{{#each expiringToday}}` inside `{{#hasExpiringToday}}`, you enter the scope of `hasExpiringToday` (which is just `true`). Inside that scope, `expiringToday` is not directly accessible because it's a **sibling property** in the parent scope.

✅ **Correct: Use `../` to access parent scope:**
```html
{{#hasExpiringToday}}
  {{#each ../expiringToday}}
    <div>{{name}}</div>
  {{/each}}
{{/hasExpiringToday}}
```

---

## ✅ The Solution

### Final Working Code Structure:

```html
{{#hasExpiringToday}}
<div class="urgency-section urgent">
  <div class="section-title">⚠️ EXPIRING TODAY</div>
  {{#each ../expiringToday}}
  <div class="item">
    <span><span class="item-emoji">{{emoji}}</span><span class="item-name">{{name}}</span> ({{quantity}})</span>
    <span>{{date}}</span>
  </div>
  {{/each}}
</div>
{{/hasExpiringToday}}
```

**Key Points:**
1. Use `{{#each arrayName}}` for iteration (not `{{#arrayName}}`)
2. Use `../` to access parent scope when nested inside conditionals
3. Close with `{{/each}}` (not `{{/arrayName}}`)

---

## 📚 Postmark Mustachio Syntax Guide

### Basic Variable
```html
{{variableName}}
```

### Conditional (shows if true/exists)
```html
{{#conditionalVariable}}
  <div>This shows if true</div>
{{/conditionalVariable}}
```

### Array Iteration
```html
{{#each arrayName}}
  <div>{{propertyName}}</div>
{{/each}}
```

### Nested Scope - Access Parent
```html
{{#outerProperty}}
  {{#each ../siblingArray}}
    <div>{{name}}</div>
    <div>{{../parentProperty}}</div>
  {{/each}}
{{/outerProperty}}
```

### Check First Item in Loop
```html
{{#each items}}
  {{#@first}}
    <h2>List Header (only shows once)</h2>
  {{/@first}}
  <div>{{name}}</div>
{{/each}}
```

---

## 🎯 Moving Forward: Template Creation Checklist

When creating new Postmark email templates:

### ✅ Before You Start
- [ ] Remember: Postmark uses **Mustachio**, not Mustache
- [ ] Use `{{#each arrayName}}` for ALL arrays
- [ ] Use `../` when accessing sibling properties in nested scopes

### ✅ Template Structure
- [ ] Use `{{#each ../arrayName}}` when nested inside conditionals
- [ ] Close all loops with `{{/each}}` (not `{{/arrayName}}`)
- [ ] Test with real JSON data immediately

### ✅ Testing Process
1. Create template in Postmark
2. Add test data in "Test Data" section (full JSON)
3. Click "Preview" to see rendered email
4. If items don't appear → Check for scope issues
5. Send test email to yourself before going live

---

## 🔧 Common Issues & Quick Fixes

### Issue: "Uh oh! We found some issues with your template"
**Cause:** Variable used in template but not in test data
**Fix:** Add all variables to test data JSON

### Issue: Sections show but items don't
**Cause:** Using `{{#arrayName}}` instead of `{{#each arrayName}}`
**Fix:** Replace all `{{#arrayName}}` with `{{#each arrayName}}`

### Issue: Items still don't show after using {{#each}}
**Cause:** Nested scope problem
**Fix:** Add `../` → `{{#each ../arrayName}}`

### Issue: Variables showing as {{variableName}} in preview
**Cause:** Variable name mismatch or missing from test data
**Fix:** Check spelling, ensure test data has exact variable names

---

## 📖 Official Resources

- **Postmark Template Syntax Guide:** https://postmarkapp.com/support/article/1077-template-syntax
- **Mustachio Documentation:** https://postmarkapp.com/blog/why-were-nuts-about-mustachio
- **Template API Docs:** https://postmarkapp.com/developer/api/templates-api

---

## 🎓 Key Learnings (November 22, 2025)

1. **Postmark ≠ Mustache**: Postmark uses Mustachio, which requires `{{#each}}` for arrays
2. **Scope matters**: Nested properties need `../` to access parent scope
3. **Test immediately**: Don't wait until the end to test with real data
4. **Read the docs**: Email templating engines often have quirks
5. **Document issues**: Save time by documenting solutions (like this file!)

---

## 📝 Example: Complete Working Template

```html
<!DOCTYPE html>
<html>
<body>
  <h1>Hey {{firstName}}!</h1>

  <p>You have {{totalCount}} items expiring soon:</p>

  {{#hasExpiringToday}}
  <div style="background: #ffebee; padding: 15px;">
    <strong>⚠️ EXPIRING TODAY</strong>
    {{#each ../expiringToday}}
      <div>{{emoji}} {{name}} ({{quantity}}) - {{date}}</div>
    {{/each}}
  </div>
  {{/hasExpiringToday}}

  <a href="{{recipesUrl}}">Get Recipes</a>
</body>
</html>
```

**Test Data:**
```json
{
  "firstName": "Alex",
  "totalCount": 3,
  "hasExpiringToday": true,
  "expiringToday": [
    {"name": "Spinach", "quantity": 1, "date": "Nov 20", "emoji": "🥬"},
    {"name": "Milk", "quantity": 1, "date": "Nov 20", "emoji": "🥛"}
  ],
  "recipesUrl": "https://trackabite.app/recipes"
}
```

---

## 🚀 Next Steps

1. **Update main template documentation** (`POSTMARK_TEMPLATES.md`) with `../` syntax
2. **Apply fix to all 3 templates** (daily, weekly, tips)
3. **Test all templates** with real data in Postmark
4. **Send test emails** to yourself
5. **Deploy to production** once confirmed working

---

**Last Updated:** November 22, 2025
**Issue Resolution Time:** ~2 hours
**Future Time Saved:** Countless hours! 🎉

---

## 💡 Pro Tip

When in doubt with Postmark templates:
1. Start simple (no nesting)
2. Test with minimal HTML first
3. Add complexity gradually
4. Always use `{{#each}}` for arrays
5. Add `../` when nested inside other blocks

**Remember:** The `../` is your friend when working with nested Mustachio blocks! 🎯

---

# Email Delivery Troubleshooting (November 22, 2025)

## 🐛 Issue: Trial Start Emails Not Sending for Free Users Upgrading

**Status:** ✅ SOLVED

### The Problem

When existing free users upgraded to premium trial (with verified payment), they were NOT receiving the "Welcome to Trackabite Premium" trial start email, even though:
- Welcome emails were working for new free signups ✓
- Payment was processing correctly ✓
- User tier was upgrading to premium ✓
- Postmark template existed and was configured ✓
- `EMAIL_ENABLED=true` ✓

### What We Discovered

By analyzing production logs from Railway, we found:
- ✅ `handleSubscriptionUpdated` webhook was firing
- ❌ `handleSubscriptionCreated` webhook was **NOT** firing
- ❌ No trial email send attempt in logs

**The smoking gun:** The subscription was created by the frontend (`createSubscriptionIntent`) BEFORE payment, so when payment completed, Stripe sent `customer.subscription.updated` instead of `customer.subscription.created`.

### Root Cause Analysis

#### Event Flow for Different User Types:

**New Users (Onboarding Flow):**
1. User starts trial during signup
2. Stripe creates customer + subscription
3. Webhook: `customer.subscription.created` fires
4. ✅ Trial start email sent (code in `handleSubscriptionCreated`)

**Existing Free Users (Upgrade Flow):**
1. User clicks "Start Trial"
2. Frontend calls `createSubscriptionIntent` → subscription created in Stripe (status: `incomplete`)
3. User completes payment
4. Webhook: `customer.subscription.updated` fires (NOT created!)
5. ❌ No email sent (no email code in `handleSubscriptionUpdated`)

### The Fix

**File:** `/Users/jessie/fridgy/Backend/services/webhookService.js`

Added trial start email logic to `handleSubscriptionUpdated` (lines 376-410):

```javascript
// Send trial start email if this is a new trial with verified payment
// This handles free users upgrading to premium (subscription.updated event)
if (subscription.status === 'trialing' && subscription.trial_end && hasPaymentMethod) {
  console.log('[WebhookService] Trial started (updated event) with verified payment, sending email to user:', dbSub.user_id);

  const supabase = getServiceClient();

  // Get user details for email
  const { data: user, error: userError } = await supabase
    .from('users')
    .select('email, first_name')
    .eq('id', dbSub.user_id)
    .single();

  if (userError) {
    console.error('[WebhookService] Error fetching user for trial email:', userError);
  } else if (user) {
    // Get customer timezone from Stripe metadata
    let timezone = 'America/Los_Angeles'; // default
    try {
      const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
      const customer = await stripe.customers.retrieve(subscription.customer);
      if (customer.metadata && customer.metadata.timezone) {
        timezone = customer.metadata.timezone;
      }
    } catch (tzError) {
      console.error('[WebhookService] Error fetching customer timezone:', tzError.message);
    }

    const trialEndDate = new Date(subscription.trial_end * 1000);
    await emailService.sendTrialStartEmail(user, trialEndDate, timezone);
  }
}
```

**Result:** Trial start emails now send for BOTH user flows:
- New signups → `customer.subscription.created` ✓
- Free users upgrading → `customer.subscription.updated` ✓

---

## 🐛 Issue: Welcome Emails Not Sending for Users Who Abandoned Trial

**Status:** ✅ SOLVED

### The Problem

Users who:
1. Started the trial signup flow
2. Closed the browser without completing payment
3. Later signed up for a free account

Were NOT receiving the welcome email.

### Root Cause

**File:** `/Users/jessie/fridgy/Backend/controller/authController.js`

The signup flow had this logic (lines 109-246):

```javascript
if (onboardingSessionId) {
  // Try to link payment
  if (session && session.payment_confirmed) {
    // Send trial email
  }
  // NO else block for abandoned sessions!
} else {
  // Send welcome email (only if NO session ID)
}
```

**The bug:**
- Users who abandoned trial had `onboardingSessionId` in localStorage
- Code entered the `if (onboardingSessionId)` block
- Payment was NOT confirmed → skipped trial email
- Code did NOT enter the `else` block → skipped welcome email
- Result: NO email sent!

### The Fix

Changed the logic to use a `paymentLinked` flag:

```javascript
let paymentLinked = false;

if (onboardingSessionId) {
  // Try to link payment
  if (session && session.payment_confirmed) {
    paymentLinked = true;
    // Send trial email
  }
}

// Send welcome email to free users (no payment linked)
// This covers both users who never started onboarding AND users who abandoned it
if (!paymentLinked) {
  await emailService.sendWelcomeEmail({
    email: newUser.email,
    first_name: newUser.first_name
  });
}
```

**Result:** Welcome emails now send to ALL free users, regardless of whether they abandoned a trial flow.

---

## 🐛 Issue: Payment Success Email Not Sending

**Status:** ✅ SOLVED

### The Problem

When users converted from trial to paid (or made any payment), the payment success email was not being sent.

### Root Cause

**File:** `/Users/jessie/fridgy/Backend/services/webhookService.js`

JavaScript scoping bug in `handlePaymentSucceeded` (lines 431-452):

```javascript
async function handlePaymentSucceeded(invoice) {
  try {
    // ... code ...

    // supabase declared INSIDE this if block
    if (hasPaymentMethod) {
      const supabase = getServiceClient(); // ← Line 431
      await supabase.from('users').update(...)
    } // ← supabase goes out of scope!

    // Trying to send email here
    if (invoice.billing_reason === 'subscription_cycle') {
      const { data: user } = await supabase // ← Line 452: ReferenceError!
        .from('users').select(...)
    }
  }
}
```

**The bug:** `supabase` was declared inside the `if (hasPaymentMethod)` block but used outside of it, causing a ReferenceError that prevented email sending.

### The Fix

Moved `const supabase = getServiceClient()` to the top of the function (line 390):

```javascript
async function handlePaymentSucceeded(invoice) {
  try {
    const supabase = getServiceClient(); // ← Moved here!

    // Now available everywhere in the function
    if (hasPaymentMethod) {
      await supabase.from('users').update(...) // ✓
    }

    if (invoice.billing_reason === 'subscription_cycle') {
      const { data: user } = await supabase // ✓ Now works!
        .from('users').select(...)
    }
  }
}
```

**Result:** Payment success emails now send correctly.

---

## 📊 Complete Email Flow Summary

### Free User Signup (No Trial)
1. User signs up → `authController.signup`
2. No payment → `paymentLinked = false`
3. ✅ **Welcome email sent** (template: `'welcome'`)

### Free User Upgrades to Trial
1. User already has account (got welcome email)
2. Clicks "Start Trial" → Frontend creates subscription
3. User completes payment
4. Webhook: `customer.subscription.updated` fires
5. ✅ **Trial start email sent** (template: `'trial-start'`)

### New User Signs Up with Trial
1. User goes through onboarding with payment
2. Webhook: `customer.subscription.created` fires
3. ✅ **Trial start email sent** (template: `'trial-start'`)

### Trial Converts to Paid
1. Trial period ends
2. Stripe charges customer
3. Webhook: `invoice.payment_succeeded` fires
4. ✅ **Payment success email sent** (template: `'payment-success'`)

---

## 🎓 Key Learnings for Email Systems

### 1. Always Check Production Logs First
Don't guess at the problem. Check logs to see:
- Which webhooks are actually firing
- What the actual event flow is
- Where the code is failing

**In our case:** Logs showed `subscription.updated` was firing, not `subscription.created`, which immediately revealed the issue.

### 2. Understand Stripe Webhook Event Order

Different user flows trigger different webhook events:

| Flow | Frontend Action | Webhook Event |
|------|----------------|---------------|
| Onboarding signup | Stripe Checkout creates subscription | `subscription.created` |
| Existing user upgrade | Frontend creates subscription | `subscription.updated` |
| Payment succeeds | Charge processed | `invoice.payment_succeeded` |
| Subscription ends | Trial/payment failed | `subscription.deleted` |

**Lesson:** Don't assume all subscription starts fire `subscription.created`!

### 3. Variable Scoping is Critical

In complex handlers, scope bugs can silently break email sending:
- ✅ Declare shared resources (like `supabase`) at function scope
- ❌ Don't declare them inside conditional blocks if used outside

**Our bug:** `const supabase` inside an `if` block caused ReferenceError later.

### 4. Handle All User Flows

Don't just code for the "happy path":
- New users
- Existing users upgrading
- Users who abandon flows
- Users who return after abandoning

**Our bug:** Code only handled "new signups" and "completed payments", not "abandoned then returned".

### 5. Use Flags Over Nested Conditionals

Instead of:
```javascript
if (condition) {
  if (subCondition) {
    doThing();
  }
} else {
  doOtherThing();
}
```

Use:
```javascript
let shouldDoThing = false;
if (condition && subCondition) {
  shouldDoThing = true;
}

if (shouldDoThing) {
  doThing();
} else {
  doOtherThing();
}
```

**Benefit:** Easier to read, debug, and modify.

### 6. Test All Email Scenarios

Before deploying, manually test:
- [ ] Free signup → Welcome email
- [ ] Free user upgrades → Trial email
- [ ] New signup with trial → Trial email
- [ ] Trial converts to paid → Payment success email
- [ ] User abandons trial then signs up free → Welcome email

---

## 🔧 Debugging Process That Worked

1. **Reproduce the issue** - Do the exact user flow
2. **Check Railway logs** - See what's actually happening
3. **Identify which webhooks fire** - Don't assume!
4. **Trace the code path** - Follow the actual execution
5. **Find the gap** - Where should email send but doesn't?
6. **Fix precisely** - Don't over-engineer, just fix the gap
7. **Test again** - Verify all flows work

---

## 🚀 Moving Forward: Email System Best Practices

### When Adding New Email Types

1. **Identify ALL triggers**
   - Which user actions should send this email?
   - Which webhook events are involved?
   - What are the edge cases?

2. **Add email logic to ALL relevant handlers**
   - Don't assume one webhook event is enough
   - Check both `created` and `updated` events
   - Consider async frontend creation flows

3. **Test every flow**
   - New users
   - Existing users
   - Abandoned flows
   - Edge cases

4. **Add logging**
   - Log when email sending is attempted
   - Log success/failure with MessageID
   - Makes debugging 10x easier

5. **Check environment variables**
   - `EMAIL_ENABLED=true`
   - Postmark API key set
   - Template aliases match exactly
   - Sender email verified

### Email Checklist

Before deploying new emails:

- [ ] Template created in Postmark with correct alias
- [ ] Template tested with real data in Postmark UI
- [ ] Test email sent to yourself
- [ ] Code calls `emailService.send*Email()` in ALL relevant places
- [ ] Logging added for debugging
- [ ] All user flows tested manually
- [ ] Production logs checked after deploy

---

## 📝 Files Modified (November 22, 2025)

1. **`/Backend/services/webhookService.js`**
   - Added trial email to `handleSubscriptionUpdated` (lines 376-410)
   - Fixed scoping bug in `handlePaymentSucceeded` (line 390)
   - Added user lookup to `handleSubscriptionCreated` (lines 223-258)

2. **`/Backend/controller/authController.js`**
   - Added `paymentLinked` flag (line 110)
   - Fixed welcome email logic (lines 237-253)

---

## 💡 Pro Tips

1. **Always check which webhook event actually fires** - Don't trust assumptions about Stripe event order

2. **Read production logs before coding** - They tell you exactly where the problem is

3. **Scope variables at function level** - Especially for shared resources like database clients

4. **Use flags for complex conditional logic** - Makes code more readable and maintainable

5. **Document weird edge cases** - Like "subscription.updated fires instead of created for frontend-created subscriptions"

---

**Last Updated:** November 22, 2025
**Total Bugs Fixed:** 3 (Trial email, Welcome email, Payment email)
**Root Cause:** Wrong webhook event assumptions + scoping bugs + conditional logic gaps
**Time to Debug:** ~3 hours
**Time Saved Moving Forward:** Countless hours! 🎉
