const jwt = require('jsonwebtoken');
const { createClient } = require('@supabase/supabase-js');

// Initialize Supabase client function
const getSupabaseClient = () => {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_ANON_KEY;
  
  if (!supabaseUrl || !supabaseKey) {
    throw new Error('Supabase configuration missing');
  }
  
  return createClient(supabaseUrl, supabaseKey);
};

// JWT secret
const JWT_SECRET = process.env.JWT_SECRET || 'your-super-secret-jwt-key-change-in-production';

const authenticateToken = async (req, res, next) => {
  const requestId = Math.random().toString(36).substring(7);
  
  try {
    console.log(`🔐 [${requestId}] Authentication request for ${req.method} ${req.path}`);
    
    const token = req.headers.authorization?.replace('Bearer ', '');
    
    if (!token) {
      console.log(`❌ [${requestId}] No token provided`);
      return res.status(401).json({
        success: false,
        error: 'Access token required'
      });
    }

    // Verify JWT token
    const decoded = jwt.verify(token, JWT_SECRET);
    console.log(`🔐 [${requestId}] Token decoded, userId: ${decoded.userId}`);
    
    // Get user data from database
    const supabase = getSupabaseClient();
    const { data: user, error } = await supabase
      .from('users')
      .select('id, email, first_name')
      .eq('id', decoded.userId)
      .single();

    if (error || !user) {
      console.log(`❌ [${requestId}] User not found in database:`, error?.message || 'No user returned');
      return res.status(401).json({
        success: false,
        error: 'Invalid token'
      });
    }

    // Add user to request object
    req.user = {
      id: user.id,
      email: user.email,
      firstName: user.first_name
    };
    
    console.log(`✅ [${requestId}] Authentication successful for user: ${user.email}`);
    next();
  } catch (error) {
    console.error(`❌ [${requestId}] Authentication error:`, error.message);
    return res.status(401).json({
      success: false,
      error: 'Invalid token'
    });
  }
};

module.exports = { authenticateToken }; 