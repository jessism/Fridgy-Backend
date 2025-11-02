const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const authService = require('../services/authService');
const { createDefaultRecipe } = require('../services/defaultRecipe');

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

// Generate JWT token (1 hour expiry)
const generateToken = (userId) => {
  return jwt.sign({ userId }, JWT_SECRET, { expiresIn: '1h' });
};

// Generate refresh token (30 days expiry)
const generateRefreshToken = (userId) => {
  return jwt.sign({ userId, type: 'refresh' }, REFRESH_SECRET, { expiresIn: '30d' });
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
      const { firstName, email, password } = req.body;

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
      const token = generateToken(newUser.id);
      const refreshToken = generateRefreshToken(newUser.id);

      // Create default welcome recipe for new user (non-blocking)
      createDefaultRecipe(newUser.id).catch(err => {
        console.error('[Signup] Failed to create default recipe for new user:', newUser.id, err);
      });

      // Return success response with tokens
      res.status(201).json({
        success: true,
        message: 'User created successfully',
        user: {
          id: newUser.id,
          email: newUser.email,
          firstName: newUser.first_name,
          createdAt: newUser.created_at,
          hasSeenWelcomeTour: newUser.has_seen_welcome_tour || false
        },
        token,
        refreshToken
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
      const { email, password } = req.body;

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
      const token = generateToken(user.id);
      const refreshToken = generateRefreshToken(user.id);

      // Return success response with tokens
      res.json({
        success: true,
        message: 'Login successful',
        user: {
          id: user.id,
          email: user.email,
          firstName: user.first_name,
          createdAt: user.created_at,
          hasSeenWelcomeTour: user.has_seen_welcome_tour || false
        },
        token,
        refreshToken
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
      // User already verified by middleware - req.user is set
      if (!req.user || !req.user.id) {
        return res.status(401).json({
          success: false,
          error: 'User not authenticated'
        });
      }

      // Get fresh user data
      const user = await authService.findUserById(req.user.id);
      if (!user) {
        return res.status(404).json({
          success: false,
          error: 'User not found'
        });
      }

      // Generate fresh tokens for session refresh
      const newToken = generateToken(user.id);
      const newRefreshToken = generateRefreshToken(user.id);

      // Return user data with fresh tokens
      res.json({
        success: true,
        user: {
          id: user.id,
          email: user.email,
          firstName: user.first_name,
          createdAt: user.created_at
        },
        token: newToken,
        refreshToken: newRefreshToken
      });

    } catch (error) {
      console.error('Get user error:', error);
      res.status(500).json({
        success: false,
        error: 'Server error while fetching user'
      });
    }
  },

  // Refresh token controller
  async refreshToken(req, res) {
    try {
      const { refreshToken } = req.body;

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
      const newToken = generateToken(user.id);
      const newRefreshToken = generateRefreshToken(user.id);

      res.json({
        success: true,
        token: newToken,
        refreshToken: newRefreshToken,
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
  },

  // Mark welcome tour as completed
  async markWelcomeTourComplete(req, res) {
    try {
      const userId = req.user.id;

      const { data: user, error } = await supabase
        .from('users')
        .update({ has_seen_welcome_tour: true })
        .eq('id', userId)
        .select()
        .single();

      if (error) {
        throw error;
      }

      res.json({
        success: true,
        message: 'Welcome tour marked as completed',
        hasSeenWelcomeTour: true
      });

    } catch (error) {
      console.error('Mark welcome tour error:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to update welcome tour status'
      });
    }
  }
};

module.exports = authController;