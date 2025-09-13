const { createClient } = require('@supabase/supabase-js');

// Validate environment variables
const validateEnvironment = () => {
  const required = ['SUPABASE_URL', 'SUPABASE_ANON_KEY'];
  const missing = required.filter(key => !process.env[key]);
  
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }
};

// Create client with anon key (respects RLS)
const createAnonClient = () => {
  validateEnvironment();
  return createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_ANON_KEY
  );
};

// Create client with service key (bypasses RLS) - for admin operations only
const createServiceClient = () => {
  validateEnvironment();
  
  // Use service key if available, otherwise fall back to anon key
  // In production, service key should always be present
  const serviceKey = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY;
  
  if (!process.env.SUPABASE_SERVICE_KEY) {
    console.warn('⚠️ SUPABASE_SERVICE_KEY not found - using ANON_KEY. This may cause RLS issues.');
  }
  
  return createClient(
    process.env.SUPABASE_URL,
    serviceKey,
    {
      auth: {
        autoRefreshToken: false,
        persistSession: false
      }
    }
  );
};

// Export singleton instances
let anonClient = null;
let serviceClient = null;

const getAnonClient = () => {
  if (!anonClient) {
    anonClient = createAnonClient();
  }
  return anonClient;
};

const getServiceClient = () => {
  if (!serviceClient) {
    serviceClient = createServiceClient();
  }
  return serviceClient;
};

module.exports = {
  getAnonClient,
  getServiceClient,
  // For backward compatibility
  getSupabaseClient: getAnonClient
};