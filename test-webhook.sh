#!/bin/bash
# Quick test script for RevenueCat webhook endpoint
# Run this after starting the local server

# Colors for output
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

WEBHOOK_SECRET="0a8894e856018e8c9be9f2049c7711534b1e834674f1fe38f0d165b265e76750"
BASE_URL="http://localhost:5000"

echo -e "${YELLOW}Testing RevenueCat Webhook Endpoint${NC}\n"

# Test 1: Health Check
echo -e "${YELLOW}Test 1: Health Check${NC}"
curl -s $BASE_URL/api/webhooks/revenuecat/health | jq '.'
echo -e "\n"

# Test 2: Upgrade Event
echo -e "${YELLOW}Test 2: Upgrade Event (INITIAL_PURCHASE)${NC}"
curl -s -X POST $BASE_URL/api/webhooks/revenuecat \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $WEBHOOK_SECRET" \
  -d '{
    "event": {
      "id": "test-local-001",
      "type": "INITIAL_PURCHASE",
      "app_user_id": "webhooktest@example.com",
      "product_id": "com.trackabite.pro.monthly"
    }
  }' | jq '.'
echo -e "\n"

# Test 3: Duplicate Event (Idempotency)
echo -e "${YELLOW}Test 3: Duplicate Event (should return already_processed)${NC}"
curl -s -X POST $BASE_URL/api/webhooks/revenuecat \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $WEBHOOK_SECRET" \
  -d '{
    "event": {
      "id": "test-local-001",
      "type": "INITIAL_PURCHASE",
      "app_user_id": "webhooktest@example.com",
      "product_id": "com.trackabite.pro.monthly"
    }
  }' | jq '.'
echo -e "\n"

# Test 4: Unauthorized Request
echo -e "${YELLOW}Test 4: Unauthorized Request (should return 401)${NC}"
curl -s -w "\nHTTP Status: %{http_code}\n" -X POST $BASE_URL/api/webhooks/revenuecat \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer wrong_secret" \
  -d '{
    "event": {
      "id": "test-local-002",
      "type": "INITIAL_PURCHASE",
      "app_user_id": "webhooktest@example.com",
      "product_id": "com.trackabite.pro.monthly"
    }
  }' | jq '.'
echo -e "\n"

# Test 5: Email Case Normalization
echo -e "${YELLOW}Test 5: Email Case Normalization (mixed case email)${NC}"
curl -s -X POST $BASE_URL/api/webhooks/revenuecat \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $WEBHOOK_SECRET" \
  -d '{
    "event": {
      "id": "test-local-003",
      "type": "INITIAL_PURCHASE",
      "app_user_id": "WebhookTest@Example.com",
      "product_id": "com.trackabite.pro.monthly"
    }
  }' | jq '.'
echo -e "\n"

# Test 6: TRANSFER - source account downgraded, destination untouched
# (RevenueCat sends TRANSFER with no app_user_id; needs webhooktest2@example.com to exist as a free user)
echo -e "${YELLOW}Test 6: TRANSFER webhooktest -> webhooktest2 (should return transfer_downgraded)${NC}"
curl -s -X POST $BASE_URL/api/webhooks/revenuecat \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $WEBHOOK_SECRET" \
  -d '{
    "api_version": "1.0",
    "event": {
      "id": "test-transfer-001",
      "type": "TRANSFER",
      "app_id": "test",
      "store": "APP_STORE",
      "environment": "SANDBOX",
      "event_timestamp_ms": 1756200000000,
      "transferred_from": ["WebhookTest@Example.com"],
      "transferred_to": ["webhooktest2@example.com"]
    }
  }' | jq '.'
echo -e "\n"

# Test 7: TRANSFER with anonymous ids only (should return 200 transfer_no_resolvable_source, not 400)
echo -e "${YELLOW}Test 7: TRANSFER anonymous-only (should return transfer_no_resolvable_source)${NC}"
curl -s -w "\nHTTP Status: %{http_code}\n" -X POST $BASE_URL/api/webhooks/revenuecat \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $WEBHOOK_SECRET" \
  -d '{
    "api_version": "1.0",
    "event": {
      "id": "test-transfer-002",
      "type": "TRANSFER",
      "app_id": "test",
      "event_timestamp_ms": 1756200000000,
      "transferred_from": ["$RCAnonymousID:aaaa1111"],
      "transferred_to": ["$RCAnonymousID:bbbb2222"]
    }
  }' | jq '.'
echo -e "\n"

# Test 8: EXPIRATION regression (should return downgraded, or grandfathered_skip / stripe_active_skip)
echo -e "${YELLOW}Test 8: EXPIRATION (should return downgraded)${NC}"
curl -s -X POST $BASE_URL/api/webhooks/revenuecat \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $WEBHOOK_SECRET" \
  -d '{
    "event": {
      "id": "test-exp-001",
      "type": "EXPIRATION",
      "app_user_id": "webhooktest@example.com",
      "product_id": "com.trackabite.pro.monthly"
    }
  }' | jq '.'
echo -e "\n"

echo -e "${GREEN}✅ All tests completed!${NC}"
echo -e "${YELLOW}Check your server logs for detailed output${NC}"
echo -e "${YELLOW}Query database to verify tier changes:${NC}"
echo -e "  SELECT email, tier FROM users WHERE email IN ('webhooktest@example.com','webhooktest2@example.com');"
echo -e "  DELETE FROM revenuecat_webhook_events WHERE event_id LIKE 'test-%';  -- cleanup"
