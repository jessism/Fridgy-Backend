#!/bin/bash

# Run YouTube cache migration
# Usage: ./run-youtube-migration.sh

echo "Running YouTube cache table migration..."

# Read Supabase connection details from .env
if [ ! -f .env ]; then
    echo "Error: .env file not found!"
    exit 1
fi

# Get Supabase URL from .env
SUPABASE_URL=$(grep SUPABASE_URL .env | cut -d '=' -f2)

if [ -z "$SUPABASE_URL" ]; then
    echo "Error: SUPABASE_URL not found in .env"
    echo ""
    echo "Please run this migration manually in Supabase Dashboard:"
    echo "1. Go to https://supabase.com/dashboard"
    echo "2. Select your project"
    echo "3. Go to SQL Editor"
    echo "4. Run the SQL from migrations/032_create_youtube_cache.sql"
    exit 1
fi

echo "Supabase URL: $SUPABASE_URL"
echo ""
echo "Please run this migration manually in Supabase Dashboard:"
echo "1. Go to https://supabase.com/dashboard"
echo "2. Select your project"
echo "3. Go to SQL Editor"
echo "4. Copy and run the SQL from migrations/032_create_youtube_cache.sql"
echo ""
echo "Or use the Supabase CLI:"
echo "supabase db push"
