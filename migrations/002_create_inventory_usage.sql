-- Migration: Create inventory_usage table for tracking all deductions
-- This table logs every usage of inventory items for future analytics

CREATE TABLE IF NOT EXISTS inventory_usage (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  item_id INTEGER REFERENCES fridge_items(id) ON DELETE CASCADE,  -- INTEGER to match fridge_items.id type
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  amount_used DECIMAL(10,2) NOT NULL,
  unit VARCHAR(50),
  used_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  usage_type VARCHAR(50) DEFAULT 'meal', -- 'meal', 'manual', 'expired', 'adjustment'
  meal_log_id UUID REFERENCES meal_logs(id) ON DELETE SET NULL,
  notes TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_inventory_usage_user_id ON inventory_usage(user_id);
CREATE INDEX IF NOT EXISTS idx_inventory_usage_item_id ON inventory_usage(item_id);
CREATE INDEX IF NOT EXISTS idx_inventory_usage_used_at ON inventory_usage(used_at DESC);
CREATE INDEX IF NOT EXISTS idx_inventory_usage_meal_log ON inventory_usage(meal_log_id);

-- Note: We're using custom auth (not Supabase auth), so RLS is handled at the application level
-- These policies allow the backend to read/write as needed
-- The backend controllers enforce user-specific access using JWT validation

-- Grant necessary permissions (using anon role since we're not using Supabase auth)
GRANT SELECT, INSERT, UPDATE, DELETE ON inventory_usage TO anon;
GRANT ALL ON inventory_usage TO service_role;