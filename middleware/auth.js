const jwt = require('jsonwebtoken');
const { getServiceClient } = require('../config/supabase');

// JWT secret
const JWT_SECRET = process.env.JWT_SECRET || 'your-super-secret-jwt-key-change-in-production';

const authenticateToken = async (req, res, next) => {
  try {
    // Get token from Authorization header only
    const authHeader = req.headers.authorization;

    // Debug logging
    console.log('Auth Header:', authHeader ? `${authHeader.substring(0, 20)}...` : 'None');

    if (!authHeader) {
      console.log('Authentication failed: No Authorization header');
      return res.status(401).json({
        success: false,
        error: 'No authorization header provided',
        details: 'Missing Authorization header'
      });
    }

    if (!authHeader.startsWith('Bearer ')) {
      console.log('Authentication failed: Invalid header format');
      return res.status(401).json({
        success: false,
        error: 'Invalid authorization format',
        details: 'Authorization header must start with "Bearer "'
      });
    }

    const token = authHeader.replace('Bearer ', '');

    if (!token || token === 'null' || token === 'undefined') {
      console.log('Authentication failed: Token is null or undefined');
      return res.status(401).json({
        success: false,
        error: 'Invalid token provided',
        details: 'Token value is null or undefined'
      });
    }

    // Verify JWT token
    let decoded;
    try {
      decoded = jwt.verify(token, JWT_SECRET);
      console.log('Token decoded successfully, userId:', decoded.userId);
    } catch (jwtError) {
      console.log('JWT verification failed:', jwtError.message);

      if (jwtError.name === 'TokenExpiredError') {
        return res.status(401).json({
          success: false,
          error: 'Token expired',
          details: 'Your session has expired. Please log in again.',
          expiredAt: jwtError.expiredAt
        });
      }

      if (jwtError.name === 'JsonWebTokenError') {
        return res.status(401).json({
          success: false,
          error: 'Invalid token',
          details: 'The token is malformed or invalid'
        });
      }

      throw jwtError;
    }

    // Get user data from database
    const supabase = getServiceClient();
    const { data: user, error } = await supabase
      .from('users')
      .select('id, email, first_name, is_admin, is_test')
      .eq('id', decoded.userId)
      .single();

    if (error || !user) {
      console.log('Database lookup failed:', error ? error.message : 'User not found');
      return res.status(401).json({
        success: false,
        error: 'User not found',
        details: error ? error.message : 'No user found with this token ID'
      });
    }

    // Add user to request object
    req.user = {
      id: user.id,
      email: user.email,
      firstName: user.first_name,
      // Carried so downstream middleware can tell an internal account from a
      // real one without another round trip (see middleware/featureTracking.js).
      isAdmin: user.is_admin === true,
      isTest: user.is_test === true
    };

    next();
  } catch (error) {
    console.error('Authentication error:', error.message);
    console.error('Stack trace:', error.stack);
    return res.status(401).json({
      success: false,
      error: 'Authentication failed',
      details: error.message
    });
  }
};

module.exports = { authenticateToken };