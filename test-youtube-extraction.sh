#!/bin/bash

# Test YouTube Recipe Extraction
# Usage: ./test-youtube-extraction.sh [YOUR_AUTH_TOKEN]

AUTH_TOKEN=$1

if [ -z "$AUTH_TOKEN" ]; then
    echo "❌ Error: Please provide an authentication token"
    echo ""
    echo "Usage: ./test-youtube-extraction.sh YOUR_AUTH_TOKEN"
    echo ""
    echo "To get a token:"
    echo "1. Sign in to your app"
    echo "2. Get the JWT token from localStorage or the request headers"
    exit 1
fi

BASE_URL="http://localhost:5000"

echo "🧪 Testing YouTube Recipe Extraction"
echo "=================================="
echo ""

# Test 1: Check usage stats
echo "📊 Test 1: Check usage stats"
echo "GET /api/youtube-recipes/apify-usage"
curl -s -X GET "${BASE_URL}/api/youtube-recipes/apify-usage" \
  -H "Authorization: Bearer ${AUTH_TOKEN}" | jq .
echo ""
echo ""

# Test 2: Extract from regular YouTube video (good recipe in description)
echo "🎥 Test 2: Extract from regular YouTube video"
echo "Testing with a recipe video..."
read -p "Enter a YouTube video URL (or press Enter to skip): " VIDEO_URL

if [ ! -z "$VIDEO_URL" ]; then
    echo "POST /api/youtube-recipes/multi-modal-extract"
    curl -s -X POST "${BASE_URL}/api/youtube-recipes/multi-modal-extract" \
      -H "Content-Type: application/json" \
      -H "Authorization: Bearer ${AUTH_TOKEN}" \
      -d "{\"url\": \"${VIDEO_URL}\"}" | jq .
    echo ""
fi

echo ""
echo "✅ Testing complete!"
echo ""
echo "📝 Next steps:"
echo "1. Check the output above for any errors"
echo "2. Try testing with a YouTube Short URL"
echo "3. Verify the recipe was extracted correctly"
