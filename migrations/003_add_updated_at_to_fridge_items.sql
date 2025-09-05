-- Migration: Add updated_at column to fridge_items table
-- This adds automatic timestamp tracking for when items are modified
-- Following professional database best practices

-- Step 1: Add the updated_at column (defaults to current time)
ALTER TABLE fridge_items 
ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW();

-- Step 2: Backfill existing rows with sensible defaults
-- Use created_at if available, otherwise uploaded_at, otherwise current time
UPDATE fridge_items 
SET updated_at = COALESCE(created_at, uploaded_at, NOW())
WHERE updated_at IS NULL;

-- Step 3: Create function to automatically update the timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Step 4: Create trigger to call the function on any row update
CREATE TRIGGER update_fridge_items_updated_at 
BEFORE UPDATE ON fridge_items 
FOR EACH ROW 
EXECUTE FUNCTION update_updated_at_column();

-- This ensures:
-- 1. Every item tracks when it was last modified
-- 2. The timestamp updates automatically (no code changes needed)
-- 3. We can track usage patterns and implement features like "recently modified"
-- 4. Supports future features like sync, audit trails, and analytics