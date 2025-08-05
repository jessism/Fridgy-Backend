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

// Auth Service - handles all database operations for authentication
const authService = {
  /**
   * Find user by email
   * @param {string} email - User email
   * @returns {Object|null} User object or null if not found
   */
  async findUserByEmail(email) {
    try {
      const supabase = getSupabaseClient();
      const { data: user, error } = await supabase
        .from('users')
        .select('id, email, first_name, password_hash, created_at')
        .eq('email', email.toLowerCase())
        .single();

      if (error && error.code !== 'PGRST116') {
        throw error;
      }

      return user;
    } catch (error) {
      console.error('Error finding user by email:', error);
      throw error;
    }
  },

  /**
   * Find user by ID
   * @param {string} userId - User ID
   * @returns {Object|null} User object or null if not found
   */
  async findUserById(userId) {
    try {
      const supabase = getSupabaseClient();
      const { data: user, error } = await supabase
        .from('users')
        .select('id, email, first_name, created_at')
        .eq('id', userId)
        .single();

      if (error) {
        throw error;
      }

      return user;
    } catch (error) {
      console.error('Error finding user by ID:', error);
      throw error;
    }
  },

  /**
   * Create a new user
   * @param {Object} userData - User data
   * @param {string} userData.email - User email
   * @param {string} userData.firstName - User first name
   * @param {string} userData.passwordHash - Hashed password
   * @returns {Object} Created user object
   */
  async createUser(userData) {
    try {
      const { email, firstName, passwordHash } = userData;
      
      const supabase = getSupabaseClient();
      const { data: newUser, error: insertError } = await supabase
        .from('users')
        .insert({
          email: email.toLowerCase(),
          first_name: firstName.trim(),
          password_hash: passwordHash
        })
        .select('id, email, first_name, created_at')
        .single();

      if (insertError) {
        throw insertError;
      }

      return newUser;
    } catch (error) {
      console.error('Error creating user:', error);
      throw error;
    }
  },

  /**
   * Check if user exists by email
   * @param {string} email - User email
   * @returns {boolean} True if user exists, false otherwise
   */
  async userExistsByEmail(email) {
    try {
      const supabase = getSupabaseClient();
      const { data: existingUser, error: checkError } = await supabase
        .from('users')
        .select('id, email')
        .eq('email', email.toLowerCase())
        .single();

      if (checkError && checkError.code !== 'PGRST116') {
        throw checkError;
      }

      return !!existingUser;
    } catch (error) {
      console.error('Error checking if user exists:', error);
      throw error;
    }
  },

  /**
   * Update user's last login timestamp
   * @param {string} userId - User ID
   * @returns {Object} Updated user object
   */
  async updateLastLogin(userId) {
    try {
      const supabase = getSupabaseClient();
      const { data: user, error } = await supabase
        .from('users')
        .update({
          updated_at: new Date().toISOString()
        })
        .eq('id', userId)
        .select('id, email, first_name, created_at')
        .single();

      if (error) {
        throw error;
      }

      return user;
    } catch (error) {
      console.error('Error updating last login:', error);
      throw error;
    }
  },

  /**
   * Get user statistics (for admin purposes)
   * @returns {Object} User statistics
   */
  async getUserStats() {
    try {
      const supabase = getSupabaseClient();
      const { count, error } = await supabase
        .from('users')
        .select('*', { count: 'exact', head: true });

      if (error) {
        throw error;
      }

      return {
        totalUsers: count,
        timestamp: new Date().toISOString()
      };
    } catch (error) {
      console.error('Error getting user stats:', error);
      throw error;
    }
  }
};

module.exports = authService;