const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const authService = require('../services/authService');

// JWT secret
const JWT_SECRET = process.env.JWT_SECRET || 'your-super-secret-jwt-key-change-in-production';

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
const generateToken = (userId) => {
  return jwt.sign({ userId }, JWT_SECRET, { expiresIn: '7d' });
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

      // Generate JWT token
      const token = generateToken(newUser.id);

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
        token
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

      // Generate JWT token
      const token = generateToken(user.id);

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
        token
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
  }
};

module.exports = authController;