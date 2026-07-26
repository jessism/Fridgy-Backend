const { createClient } = require('@supabase/supabase-js');

// Validate environment variables
const validateEnvironment = () => {
  const required = ['SUPABASE_URL', 'SUPABASE_SERVICE_KEY'];
  const missing = required.filter(key => !process.env[key]);

  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }
};

// Create client with service key (bypasses RLS). All backend DB access goes
// through this client; the anon key is intentionally unsupported here — a
// silent fallback to anon would break every query once RLS is enforced.
const createServiceClient = () => {
  validateEnvironment();

  return createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY,
    {
      auth: {
        autoRefreshToken: false,
        persistSession: false
      }
    }
  );
};

// Export singleton instance
let serviceClient = null;

const getServiceClient = () => {
  if (!serviceClient) {
    serviceClient = createServiceClient();
  }
  return serviceClient;
};

module.exports = {
  getServiceClient
};
