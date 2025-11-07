-- Migration: Add feedback_submissions table
-- Purpose: Store user feedback submitted through the in-app support form
-- Date: 2025-11-04

CREATE TABLE IF NOT EXISTS feedback_submissions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message TEXT NOT NULL,
  user_email VARCHAR(255) NOT NULL, -- Denormalized for easy email access
  user_name VARCHAR(200) NOT NULL,   -- Denormalized for easy email access
  status VARCHAR(20) DEFAULT 'new',  -- 'new', 'read', 'resolved'
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Add index for faster queries by user_id and status
CREATE INDEX idx_feedback_user_id ON feedback_submissions(user_id);
CREATE INDEX idx_feedback_status ON feedback_submissions(status);
CREATE INDEX idx_feedback_created_at ON feedback_submissions(created_at DESC);

-- Add RLS policies to protect user data
ALTER TABLE feedback_submissions ENABLE ROW LEVEL SECURITY;

-- Users can only read their own feedback submissions
CREATE POLICY feedback_user_read ON feedback_submissions
  FOR SELECT
  USING (auth.uid() = user_id);

-- Users can insert their own feedback
CREATE POLICY feedback_user_insert ON feedback_submissions
  FOR INSERT
  WITH CHECK (auth.uid() = user_id);

-- Admin can view all feedback (checking for admin role in JWT or specific admin email)
CREATE POLICY feedback_admin_all ON feedback_submissions
  FOR ALL
  USING (
    auth.jwt() ->> 'role' = 'admin' OR
    auth.jwt() ->> 'email' = 'admin@fridgy.app'
  );

-- Trigger to automatically update updated_at timestamp
CREATE OR REPLACE FUNCTION update_feedback_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER feedback_updated_at_trigger
  BEFORE UPDATE ON feedback_submissions
  FOR EACH ROW
  EXECUTE FUNCTION update_feedback_updated_at();

-- Grant necessary permissions to authenticated users
GRANT SELECT, INSERT ON feedback_submissions TO authenticated;
