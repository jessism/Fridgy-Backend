const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const authService = require('../services/authService');

// JWT secret
const JWT_SECRET = process.env.JWT_SECRET || 'your-super-secret-jwt-key-change-in-production';
const REFRESH_SECRET = process.env.REFRESH_SECRET || JWT_SECRET + '-refresh';

// Validation functions
const validateEmail = (email) => {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
};

const validatePassword = (password) => {
  return password.length >= 8;
};

const validateName = (name) => {
  const nameRegex = /^[a-zA-Z\s]{2,}$/;
  return nameRegex.test(name.trim());
};

// Generate JWT token
const generateToken = (userId, isPWA = false) => {
  // Shorter access token, will use refresh token for long-term auth
  return jwt.sign({ userId }, JWT_SECRET, { expiresIn: '1h' });
};

// Generate refresh token (longer lived for PWAs)
const generateRefreshToken = (userId, isPWA = false) => {
  // PWAs get 30-day refresh tokens, web gets 7-day
  const expiresIn = isPWA ? '30d' : '7d';
  return jwt.sign({ userId, type: 'refresh' }, REFRESH_SECRET, { expiresIn });
};

// Verify refresh token
const verifyRefreshToken = (token) => {
  try {
    const decoded = jwt.verify(token, REFRESH_SECRET);
    if (decoded.type !== 'refresh') {
      throw new Error('Invalid token type');
    }
    return decoded;
  } catch (error) {
    throw new Error('Invalid refresh token');
  }
};

// Auth Controller Functions
const authController = {
  // Sign up controller
  async signup(req, res) {
    try {
      const { firstName, email, password, isPWA } = req.body;

      // Validation
      if (!validateName(firstName)) {
        return res.status(400).json({
          success: false,
          error: 'Name must be at least 2 characters long and contain only letters and spaces'
        });
      }

      if (!validateEmail(email)) {
        return res.status(400).json({
          success: false,
          error: 'Please enter a valid email address'
        });
      }

      if (!validatePassword(password)) {
        return res.status(400).json({
          success: false,
          error: 'Password must be at least 8 characters long'
        });
      }

      // Check if user already exists
      const userExists = await authService.userExistsByEmail(email);
      if (userExists) {
        return res.status(400).json({
          success: false,
          error: 'User with this email already exists'
        });
      }

      // Hash password
      const saltRounds = 12;
      const passwordHash = await bcrypt.hash(password, saltRounds);

      // Create new user
      const newUser = await authService.createUser({
        email,
        firstName,
        passwordHash
      });

      // Generate JWT and refresh tokens
      const token = generateToken(newUser.id, isPWA);
      const refreshToken = generateRefreshToken(newUser.id, isPWA);

      // Return success response
      res.status(201).json({
        success: true,
        message: 'User created successfully',
        user: {
          id: newUser.id,
          email: newUser.email,
          firstName: newUser.first_name,
          createdAt: newUser.created_at
        },
        token,
        refreshToken,
        expiresIn: 3600, // 1 hour in seconds
        refreshExpiresIn: isPWA ? 2592000 : 604800 // 30 days or 7 days in seconds
      });

    } catch (error) {
      console.error('Signup error:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to create user'
      });
    }
  },

  // Sign in controller
  async signin(req, res) {
    try {
      const { email, password, isPWA } = req.body;

      // Validation
      if (!validateEmail(email)) {
        return res.status(400).json({
          success: false,
          error: 'Please enter a valid email address'
        });
      }

      if (!validatePassword(password)) {
        return res.status(400).json({
          success: false,
          error: 'Password must be at least 8 characters long'
        });
      }

      // Find user by email
      const user = await authService.findUserByEmail(email);
      if (!user) {
        return res.status(401).json({
          success: false,
          error: 'Invalid email or password'
        });
      }

      // Check password
      const isPasswordValid = await bcrypt.compare(password, user.password_hash);
      if (!isPasswordValid) {
        return res.status(401).json({
          success: false,
          error: 'Invalid email or password'
        });
      }

      // Generate JWT and refresh tokens
      const token = generateToken(user.id, isPWA);
      const refreshToken = generateRefreshToken(user.id, isPWA);

      // Return success response
      res.json({
        success: true,
        message: 'Login successful',
        user: {
          id: user.id,
          email: user.email,
          firstName: user.first_name,
          createdAt: user.created_at
        },
        token,
        refreshToken,
        expiresIn: 3600, // 1 hour in seconds
        refreshExpiresIn: isPWA ? 2592000 : 604800 // 30 days or 7 days in seconds
      });

    } catch (error) {
      console.error('Signin error:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to authenticate user'
      });
    }
  },

  // Get current user controller
  async getCurrentUser(req, res) {
    try {
      const token = req.headers.authorization?.replace('Bearer ', '');
      
      if (!token) {
        return res.status(401).json({
          success: false,
          error: 'No token provided'
        });
      }

      // Verify JWT token
      const decoded = jwt.verify(token, JWT_SECRET);
      
      // Get user data
      const user = await authService.findUserById(decoded.userId);
      if (!user) {
        return res.status(401).json({
          success: false,
          error: 'Invalid token'
        });
      }

      res.json({
        success: true,
        user: {
          id: user.id,
          email: user.email,
          firstName: user.first_name,
          createdAt: user.created_at
        }
      });

    } catch (error) {
      console.error('Get user error:', error);
      res.status(401).json({
        success: false,
        error: 'Invalid token'
      });
    }
  },

  // Refresh token controller
  async refreshToken(req, res) {
    try {
      const { refreshToken, isPWA } = req.body;

      if (!refreshToken) {
        return res.status(401).json({
          success: false,
          error: 'No refresh token provided'
        });
      }

      // Verify refresh token
      let decoded;
      try {
        decoded = verifyRefreshToken(refreshToken);
      } catch (error) {
        return res.status(401).json({
          success: false,
          error: 'Invalid or expired refresh token'
        });
      }

      // Get user to ensure they still exist
      const user = await authService.findUserById(decoded.userId);
      if (!user) {
        return res.status(401).json({
          success: false,
          error: 'User not found'
        });
      }

      // Generate new tokens
      const newToken = generateToken(user.id, isPWA);
      const newRefreshToken = generateRefreshToken(user.id, isPWA);

      res.json({
        success: true,
        token: newToken,
        refreshToken: newRefreshToken,
        expiresIn: 3600, // 1 hour in seconds
        refreshExpiresIn: isPWA ? 2592000 : 604800, // 30 days or 7 days
        user: {
          id: user.id,
          email: user.email,
          firstName: user.first_name,
          createdAt: user.created_at
        }
      });

    } catch (error) {
      console.error('Refresh token error:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to refresh token'
      });
    }
  },

  // Logout controller
  async logout(req, res) {
    try {
      const token = req.headers.authorization?.replace('Bearer ', '');
      
      if (!token) {
        return res.status(400).json({
          success: false,
          error: 'No token provided'
        });
      }

      // For JWT tokens, we can't actually invalidate them server-side without 
      // implementing a blacklist. For now, we'll just return success and let 
      // the client handle clearing the token.
      // In a production app, you might want to:
      // 1. Add token to a blacklist table in database
      // 2. Check blacklist in auth middleware
      // 3. Or use shorter JWT expiration with refresh tokens

      res.json({
        success: true,
        message: 'Logout successful'
      });

    } catch (error) {
      console.error('Logout error:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to logout'
      });
    }
  }
};

module.exports = authController;