const { createClient } = require('@supabase/supabase-js');

const getSupabaseClient = () => {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseKey) {
    throw new Error('Supabase configuration missing');
  }

  return createClient(supabaseUrl, supabaseKey);
};

/**
 * Middleware that checks if the authenticated user is an admin.
 * Must be used AFTER authenticateToken middleware.
 */
const requireAdmin = async (req, res, next) => {
  try {
    if (!req.user || !req.user.id) {
      return res.status(401).json({
        success: false,
        error: 'Authentication required'
      });
    }

    const supabase = getSupabaseClient();
    const { data: user, error } = await supabase
      .from('users')
      .select('is_admin')
      .eq('id', req.user.id)
      .single();

    if (error || !user) {
      return res.status(401).json({
        success: false,
        error: 'User not found'
      });
    }

    if (!user.is_admin) {
      return res.status(403).json({
        success: false,
        error: 'Admin access required'
      });
    }

    next();
  } catch (error) {
    console.error('Admin auth error:', error.message);
    return res.status(500).json({
      success: false,
      error: 'Authorization check failed'
    });
  }
};

module.exports = { requireAdmin };
