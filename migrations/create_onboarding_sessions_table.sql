-- Create onboarding_sessions table for managing anonymous payment sessions
CREATE TABLE IF NOT EXISTS onboarding_sessions (
  session_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  stripe_customer_id VARCHAR(255),
  stripe_subscription_id VARCHAR(255),
  payment_confirmed BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  linked_user_id UUID,
  metadata JSONB DEFAULT '{}',

  -- Foreign key to users table (nullable until account is created)
  CONSTRAINT fk_linked_user
    FOREIGN KEY (linked_user_id)
    REFERENCES public.users(id)
    ON DELETE SET NULL
);

-- Create indexes for performance
CREATE INDEX idx_onboarding_sessions_session_id ON onboarding_sessions(session_id);
CREATE INDEX idx_onboarding_sessions_stripe_customer ON onboarding_sessions(stripe_customer_id);
CREATE INDEX idx_onboarding_sessions_stripe_subscription ON onboarding_sessions(stripe_subscription_id);
CREATE INDEX idx_onboarding_sessions_expires_at ON onboarding_sessions(expires_at);
CREATE INDEX idx_onboarding_sessions_linked_user ON onboarding_sessions(linked_user_id);

-- Add comment to table
COMMENT ON TABLE onboarding_sessions IS 'Stores temporary onboarding sessions for anonymous users making payments before account creation';

-- Add comments to columns
COMMENT ON COLUMN onboarding_sessions.session_id IS 'Unique identifier for the onboarding session';
COMMENT ON COLUMN onboarding_sessions.stripe_customer_id IS 'Stripe customer ID created for this session';
COMMENT ON COLUMN onboarding_sessions.stripe_subscription_id IS 'Stripe subscription ID created for this session';
COMMENT ON COLUMN onboarding_sessions.payment_confirmed IS 'Whether payment has been confirmed for this session';
COMMENT ON COLUMN onboarding_sessions.expires_at IS 'When this session expires (24 hours from creation)';
COMMENT ON COLUMN onboarding_sessions.linked_user_id IS 'User ID once account is created and linked';
COMMENT ON COLUMN onboarding_sessions.metadata IS 'Additional session data in JSON format';

-- Create function to automatically update updated_at
CREATE OR REPLACE FUNCTION update_onboarding_sessions_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create trigger to update updated_at
CREATE TRIGGER update_onboarding_sessions_updated_at_trigger
  BEFORE UPDATE ON onboarding_sessions
  FOR EACH ROW
  EXECUTE FUNCTION update_onboarding_sessions_updated_at();

-- Create function to clean up expired sessions (run periodically)
CREATE OR REPLACE FUNCTION cleanup_expired_onboarding_sessions()
RETURNS INTEGER AS $$
DECLARE
  deleted_count INTEGER;
BEGIN
  DELETE FROM onboarding_sessions
  WHERE expires_at < NOW()
    AND linked_user_id IS NULL
    AND payment_confirmed = FALSE;

  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$$ LANGUAGE plpgsql;

-- Grant permissions for the service role
GRANT ALL ON onboarding_sessions TO service_role;

-- Enable Row Level Security
ALTER TABLE onboarding_sessions ENABLE ROW LEVEL SECURITY;

-- Create policy for service role (full access)
CREATE POLICY "Service role has full access to onboarding_sessions"
  ON onboarding_sessions
  FOR ALL
  TO service_role
  USING (true);