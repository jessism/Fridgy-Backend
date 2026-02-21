# RevenueCat Webhook - Local Testing Guide

## Prerequisites
✅ Code changes already implemented
✅ REVENUECAT_SECRET_API_KEY already in .env
❌ Need to add REVENUECAT_WEBHOOK_SECRET

---

## Step 1: Add Webhook Secret to .env

Add this line to your `/Users/jessie/fridgy/Backend/.env` file:

```bash
# RevenueCat Webhook Secret (for webhook authentication)
# Generate with: openssl rand -hex 32
REVENUECAT_WEBHOOK_SECRET=your_random_secret_here
```

**Generate a random secret:**
```bash
openssl rand -hex 32
```

Copy the output and paste it as the value for `REVENUECAT_WEBHOOK_SECRET`.

---

## Step 2: Run Database Migration

**Connect to your Supabase database:**

### Option A: Using Supabase Dashboard (Easiest)
1. Go to: https://supabase.com/dashboard/project/aimvjpndmipmtavpmjnn
2. Click: **SQL Editor** in left sidebar
3. Click: **New Query**
4. Copy and paste the contents of `/Users/jessie/fridgy/Backend/migrations/003_create_revenuecat_webhook_events.sql`
5. Click: **Run**
6. Verify output shows table created and grandfathered users count

### Option B: Using psql (Command Line)
```bash
# Get connection string from Supabase Dashboard → Project Settings → Database
# Then run:
psql "postgresql://postgres:[YOUR-PASSWORD]@db.aimvjpndmipmtavpmjnn.supabase.co:5432/postgres" \
  -f /Users/jessie/fridgy/Backend/migrations/003_create_revenuecat_webhook_events.sql
```

**Verify migration successful:**
```sql
-- Check table exists
SELECT COUNT(*) FROM revenuecat_webhook_events;

-- Check grandfathered users
SELECT email, is_grandfathered, tier
FROM users
WHERE is_grandfathered = TRUE;
```

---

## Step 3: Start Local Backend Server

```bash
cd /Users/jessie/fridgy/Backend
npm install  # If dependencies not installed
npm start    # Or npm run dev if using nodemon
```

**Expected output:**
```
Server running on port 5000
Connected to Supabase
```

---

## Step 4: Test Health Check Endpoint

**In a new terminal:**
```bash
curl http://localhost:5000/api/webhooks/revenuecat/health
```

**Expected response:**
```json
{
  "status": "ok",
  "revenuecat_secret_configured": true,
  "revenuecat_webhook_secret_configured": true,
  "endpoint": "/api/webhooks/revenuecat",
  "timestamp": "2026-02-20T..."
}
```

✅ If both secrets show `true`, you're ready to test!

---

## Step 5: Test Webhook with Fake Events

### Test 1: Upgrade Event (INITIAL_PURCHASE)

**Create a test user first:**
```sql
-- In Supabase SQL Editor
INSERT INTO users (email, tier, first_name)
VALUES ('webhooktest@example.com', 'free', 'Webhook Test')
ON CONFLICT (email) DO NOTHING;
```

**Send webhook:**
```bash
curl -X POST http://localhost:5000/api/webhooks/revenuecat \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_WEBHOOK_SECRET" \
  -d '{
    "event": {
      "id": "test-local-001",
      "type": "INITIAL_PURCHASE",
      "app_user_id": "webhooktest@example.com",
      "product_id": "com.trackabite.pro.monthly"
    }
  }'
```

**Expected response:**
```json
{
  "received": true,
  "event_id": "test-local-001",
  "event_type": "INITIAL_PURCHASE",
  "status": "upgraded"
}
```

**Verify in database:**
```sql
-- Check user upgraded
SELECT email, tier FROM users WHERE email = 'webhooktest@example.com';
-- Expected: tier = 'premium'

-- Check event logged
SELECT * FROM revenuecat_webhook_events WHERE event_id = 'test-local-001';
-- Expected: processed = true, error_message = null
```

### Test 2: Duplicate Event (Idempotency)

**Send the same event again:**
```bash
curl -X POST http://localhost:5000/api/webhooks/revenuecat \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_WEBHOOK_SECRET" \
  -d '{
    "event": {
      "id": "test-local-001",
      "type": "INITIAL_PURCHASE",
      "app_user_id": "webhooktest@example.com",
      "product_id": "com.trackabite.pro.monthly"
    }
  }'
```

**Expected response:**
```json
{
  "received": true,
  "event_id": "test-local-001",
  "event_type": "INITIAL_PURCHASE",
  "status": "already_processed"
}
```

✅ Idempotency works!

### Test 3: Unauthorized Request

```bash
curl -X POST http://localhost:5000/api/webhooks/revenuecat \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer wrong_secret" \
  -d '{
    "event": {
      "id": "test-local-002",
      "type": "INITIAL_PURCHASE",
      "app_user_id": "webhooktest@example.com",
      "product_id": "com.trackabite.pro.monthly"
    }
  }'
```

**Expected response:**
```json
{
  "error": "Unauthorized"
}
```

**Expected status:** 401

✅ Authentication works!

### Test 4: Email Case Normalization

```bash
curl -X POST http://localhost:5000/api/webhooks/revenuecat \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_WEBHOOK_SECRET" \
  -d '{
    "event": {
      "id": "test-local-003",
      "type": "INITIAL_PURCHASE",
      "app_user_id": "WebhookTest@Example.com",
      "product_id": "com.trackabite.pro.monthly"
    }
  }'
```

**Verify it finds the user:**
```sql
SELECT email, tier FROM users WHERE LOWER(email) = 'webhooktest@example.com';
```

✅ Email normalization works!

### Test 5: Grandfathered User Protection

**Create grandfathered test user:**
```sql
INSERT INTO users (email, tier, first_name, is_grandfathered)
VALUES ('grandfathered@example.com', 'premium', 'Grandfathered User', TRUE)
ON CONFLICT (email) DO UPDATE SET is_grandfathered = TRUE;
```

**Send cancellation event:**
```bash
curl -X POST http://localhost:5000/api/webhooks/revenuecat \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_WEBHOOK_SECRET" \
  -d '{
    "event": {
      "id": "test-local-004",
      "type": "CANCELLATION",
      "app_user_id": "grandfathered@example.com",
      "product_id": "com.trackabite.pro.monthly"
    }
  }'
```

**Expected response:**
```json
{
  "received": true,
  "event_id": "test-local-004",
  "event_type": "CANCELLATION",
  "status": "grandfathered_skip"
}
```

**Verify tier NOT changed:**
```sql
SELECT email, tier, is_grandfathered FROM users WHERE email = 'grandfathered@example.com';
-- Expected: tier STILL 'premium'
```

✅ Grandfathered protection works!

### Test 6: Downgrade Event (Non-Grandfathered User)

**Create regular user:**
```sql
INSERT INTO users (email, tier, first_name, is_grandfathered)
VALUES ('regular@example.com', 'premium', 'Regular User', FALSE)
ON CONFLICT (email) DO UPDATE SET tier = 'premium', is_grandfathered = FALSE;
```

**Send expiration event:**
```bash
curl -X POST http://localhost:5000/api/webhooks/revenuecat \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_WEBHOOK_SECRET" \
  -d '{
    "event": {
      "id": "test-local-005",
      "type": "EXPIRATION",
      "app_user_id": "regular@example.com",
      "product_id": "com.trackabite.pro.monthly"
    }
  }'
```

**Expected response:**
```json
{
  "received": true,
  "event_id": "test-local-005",
  "event_type": "EXPIRATION",
  "status": "downgraded"
}
```

**Verify tier changed:**
```sql
SELECT email, tier FROM users WHERE email = 'regular@example.com';
-- Expected: tier = 'free'
```

✅ Downgrade works for non-grandfathered users!

---

## Step 6: Check Backend Logs

In your terminal running the backend server, you should see logs like:

```
[WebhookController] RevenueCat event received: { type: 'INITIAL_PURCHASE', user: 'webhooktest@example.com', product: 'com.trackabite.pro.monthly', id: 'test-local-001' }
[WebhookController] Upgrading user webhooktest@example.com to premium
[WebhookController] ✅ User webhooktest@example.com upgraded to premium
```

---

## Optional: Test with Real RevenueCat Webhooks (Using ngrok)

If you want to test with actual RevenueCat webhooks:

### 1. Install ngrok
```bash
# macOS
brew install ngrok

# Or download from: https://ngrok.com/download
```

### 2. Start ngrok tunnel
```bash
ngrok http 5000
```

**You'll see:**
```
Forwarding  https://abc123.ngrok-free.app -> http://localhost:5000
```

### 3. Configure RevenueCat Dashboard
1. Go to: https://app.revenuecat.com/projects/YOUR-PROJECT/integrations
2. Add webhook integration
3. URL: `https://abc123.ngrok-free.app/api/webhooks/revenuecat`
4. Authorization: `Bearer YOUR_WEBHOOK_SECRET`
5. Select events: Initial Purchase, Renewal, Cancellation, Expiration
6. Click **Send Test Webhook**

### 4. Watch your local logs
You should see the test webhook arrive in your local server logs!

---

## Troubleshooting

### "Table revenuecat_webhook_events does not exist"
→ Run the migration in Step 2

### "Unauthorized" error
→ Check that REVENUECAT_WEBHOOK_SECRET matches in .env and curl command

### "User not found"
→ Create test user in database first (see Test 1)

### No logs appearing
→ Check server is running on port 5000
→ Check curl is hitting `http://localhost:5000` not production URL

### Migration fails
→ Check Supabase connection
→ Verify you have service_role permissions
→ Check if table already exists: `SELECT * FROM revenuecat_webhook_events LIMIT 1;`

---

## Cleanup Test Data

After testing, clean up test data:

```sql
-- Delete test users
DELETE FROM users WHERE email IN (
  'webhooktest@example.com',
  'grandfathered@example.com',
  'regular@example.com'
);

-- Delete test webhook events
DELETE FROM revenuecat_webhook_events WHERE event_id LIKE 'test-local-%';
```

---

## Next Steps After Local Testing

Once local testing is successful:

1. ✅ Commit code changes
2. ✅ Push to GitHub
3. ✅ Deploy to Railway
4. ✅ Add `REVENUECAT_WEBHOOK_SECRET` to Railway environment variables
5. ✅ Run migration in production database
6. ✅ Configure RevenueCat webhook to production URL
7. ✅ Test with sandbox purchase in mobile app

---

## Summary of What You're Testing

✅ **Health check** - Endpoint responds with configuration status
✅ **Authentication** - Webhook rejects unauthorized requests
✅ **Upgrade flow** - User tier changes from free → premium
✅ **Idempotency** - Duplicate events don't cause errors
✅ **Email normalization** - Mixed-case emails work correctly
✅ **Grandfathered protection** - Test users keep premium forever
✅ **Downgrade flow** - Non-grandfathered users downgrade correctly
✅ **Event logging** - All events stored in database
✅ **Error handling** - Malformed payloads handled gracefully

**Once all tests pass, you're ready for production deployment!** 🚀
