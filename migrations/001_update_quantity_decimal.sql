-- Migration: Update fridge_items quantity to support decimal values
-- This allows tracking partial quantities like 0.5 chicken, 0.25 lbs, etc.

-- Step 1: Alter the quantity column to DECIMAL type
ALTER TABLE fridge_items 
ALTER COLUMN quantity TYPE DECIMAL(10,2);

-- Note: DECIMAL(10,2) allows up to 10 digits total with 2 decimal places
-- This supports values from 0.01 to 99999999.99