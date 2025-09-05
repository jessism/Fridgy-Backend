-- Migration: Check and fix fridge_items table columns
-- This ensures all required columns exist for the deduction system to work

-- Step 1: Check what columns currently exist (run this first to see what's missing)
SELECT column_name, data_type, is_nullable, column_default
FROM information_schema.columns 
WHERE table_name = 'fridge_items'
ORDER BY ordinal_position;

-- Step 2: Add missing columns if they don't exist

-- Add updated_at column for tracking modifications
ALTER TABLE fridge_items 
ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW();

-- Add deleted_at column for soft deletes (instead of actually deleting rows)
ALTER TABLE fridge_items 
ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP WITH TIME ZONE;

-- Add delete_reason column to track why items were removed
ALTER TABLE fridge_items 
ADD COLUMN IF NOT EXISTS delete_reason VARCHAR(100);

-- Step 3: Backfill updated_at for existing rows
UPDATE fridge_items 
SET updated_at = COALESCE(created_at, uploaded_at, NOW())
WHERE updated_at IS NULL;

-- Step 4: Create or replace the auto-update function
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Step 5: Create trigger for automatic timestamp updates
-- Drop existing trigger first to avoid conflicts
DROP TRIGGER IF EXISTS update_fridge_items_updated_at ON fridge_items;

-- Create the trigger
CREATE TRIGGER update_fridge_items_updated_at 
BEFORE UPDATE ON fridge_items 
FOR EACH ROW 
EXECUTE FUNCTION update_updated_at_column();

-- Verification: Check columns again to confirm all additions
-- SELECT column_name, data_type 
-- FROM information_schema.columns 
-- WHERE table_name = 'fridge_items'
-- ORDER BY ordinal_position;