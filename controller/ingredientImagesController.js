const { createClient } = require('@supabase/supabase-js');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const path = require('path');

// Initialize Supabase client
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

// Helper function to get user ID from token
const getUserIdFromToken = (req) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  
  if (!token) {
    throw new Error('No token provided');
  }
  
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    return decoded.userId;
  } catch (error) {
    throw new Error('Invalid token');
  }
};

// Multer configuration for file uploads
const storage = multer.memoryStorage();
const upload = multer({
  storage: storage,
  limits: {
    fileSize: 5 * 1024 * 1024, // 5MB limit
  },
  fileFilter: (req, file, cb) => {
    const allowedTypes = /jpeg|jpg|png|webp/;
    const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
    const mimetype = allowedTypes.test(file.mimetype);
    
    if (mimetype && extname) {
      return cb(null, true);
    } else {
      cb(new Error('Only PNG, JPG, JPEG, and WebP images are allowed'));
    }
  }
});

const ingredientImagesController = {
  // Get ingredient image by name
  async getImageByName(req, res) {
    try {
      const { name } = req.params;
      
      if (!name) {
        return res.status(400).json({
          success: false,
          error: 'Ingredient name is required'
        });
      }
      
      const supabase = getSupabaseClient();
      
      // Use the match_ingredient_image function to find best match
      const { data, error } = await supabase
        .rpc('match_ingredient_image', { search_term: name });
      
      if (error) {
        console.error('Error fetching ingredient image:', error);
        throw error;
      }
      
      if (!data || data.length === 0) {
        return res.status(404).json({
          success: false,
          error: 'No image found for this ingredient',
          ingredient: name
        });
      }
      
      res.json({
        success: true,
        data: data[0]
      });
      
    } catch (error) {
      console.error('Error in getImageByName:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to fetch ingredient image'
      });
    }
  },
  
  // Get all ingredient images (with pagination)
  async getAllImages(req, res) {
    try {
      const { page = 1, limit = 50, category, search } = req.query;
      const offset = (page - 1) * limit;
      
      const supabase = getSupabaseClient();
      
      let query = supabase
        .from('ingredient_images')
        .select('*', { count: 'exact' })
        .eq('is_active', true)
        .order('priority', { ascending: false })
        .order('ingredient_name', { ascending: true })
        .range(offset, offset + limit - 1);
      
      // Add category filter if provided
      if (category) {
        query = query.eq('category', category);
      }
      
      // Add search filter if provided
      if (search) {
        query = query.or(`ingredient_name.ilike.%${search}%,display_name.ilike.%${search}%`);
      }
      
      const { data, error, count } = await query;
      
      if (error) {
        console.error('Error fetching ingredient images:', error);
        throw error;
      }
      
      res.json({
        success: true,
        data: data,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total: count,
          totalPages: Math.ceil(count / limit)
        }
      });
      
    } catch (error) {
      console.error('Error in getAllImages:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to fetch ingredient images'
      });
    }
  },
  
  // Upload new ingredient image
  async uploadImage(req, res) {
    try {
      // Verify user authentication
      const userId = getUserIdFromToken(req);
      
      if (!req.file) {
        return res.status(400).json({
          success: false,
          error: 'No image file provided'
        });
      }
      
      const { ingredient_name, category, aliases, tags, priority } = req.body;
      
      if (!ingredient_name) {
        return res.status(400).json({
          success: false,
          error: 'Ingredient name is required'
        });
      }
      
      const supabase = getSupabaseClient();
      
      // Generate unique filename
      const fileExt = path.extname(req.file.originalname);
      const fileName = `${ingredient_name.toLowerCase().replace(/\s+/g, '-')}-${Date.now()}${fileExt}`;
      const filePath = `ingredients/${fileName}`;
      
      // Upload to Supabase Storage
      const { data: uploadData, error: uploadError } = await supabase
        .storage
        .from('ingredient-images')
        .upload(filePath, req.file.buffer, {
          contentType: req.file.mimetype,
          upsert: false
        });
      
      if (uploadError) {
        console.error('Error uploading to storage:', uploadError);
        throw uploadError;
      }
      
      // Get public URL
      const { data: urlData } = supabase
        .storage
        .from('ingredient-images')
        .getPublicUrl(filePath);
      
      // Parse aliases and tags if they're strings
      let parsedAliases = [];
      let parsedTags = [];
      
      try {
        if (aliases) {
          parsedAliases = typeof aliases === 'string' ? JSON.parse(aliases) : aliases;
        }
        if (tags) {
          parsedTags = typeof tags === 'string' ? JSON.parse(tags) : tags;
        }
      } catch (parseError) {
        console.warn('Error parsing aliases or tags:', parseError);
      }
      
      // Insert record into ingredient_images table
      const { data: imageData, error: dbError } = await supabase
        .from('ingredient_images')
        .insert({
          ingredient_name,
          display_name: ingredient_name,
          category: category || 'Other',
          image_url: urlData.publicUrl,
          image_path: filePath,
          aliases: parsedAliases,
          tags: parsedTags,
          priority: parseInt(priority) || 0,
          source: 'manual-upload'
        })
        .select()
        .single();
      
      if (dbError) {
        console.error('Error saving to database:', dbError);
        // Try to delete the uploaded file
        await supabase.storage
          .from('ingredient-images')
          .remove([filePath]);
        throw dbError;
      }
      
      res.json({
        success: true,
        message: 'Image uploaded successfully',
        data: imageData
      });
      
    } catch (error) {
      console.error('Error in uploadImage:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to upload ingredient image'
      });
    }
  },
  
  // Update ingredient image metadata
  async updateImage(req, res) {
    try {
      const { id } = req.params;
      const { ingredient_name, display_name, category, aliases, tags, priority, is_active } = req.body;
      
      // Verify user authentication
      const userId = getUserIdFromToken(req);
      
      const supabase = getSupabaseClient();
      
      const updateData = {};
      if (ingredient_name !== undefined) updateData.ingredient_name = ingredient_name;
      if (display_name !== undefined) updateData.display_name = display_name;
      if (category !== undefined) updateData.category = category;
      if (aliases !== undefined) updateData.aliases = aliases;
      if (tags !== undefined) updateData.tags = tags;
      if (priority !== undefined) updateData.priority = priority;
      if (is_active !== undefined) updateData.is_active = is_active;
      
      const { data, error } = await supabase
        .from('ingredient_images')
        .update(updateData)
        .eq('id', id)
        .select()
        .single();
      
      if (error) {
        console.error('Error updating ingredient image:', error);
        throw error;
      }
      
      res.json({
        success: true,
        message: 'Image updated successfully',
        data
      });
      
    } catch (error) {
      console.error('Error in updateImage:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to update ingredient image'
      });
    }
  },
  
  // Delete ingredient image
  async deleteImage(req, res) {
    try {
      const { id } = req.params;
      
      // Verify user authentication
      const userId = getUserIdFromToken(req);
      
      const supabase = getSupabaseClient();
      
      // First get the image details
      const { data: imageData, error: fetchError } = await supabase
        .from('ingredient_images')
        .select('image_path')
        .eq('id', id)
        .single();
      
      if (fetchError) {
        console.error('Error fetching image:', fetchError);
        return res.status(404).json({
          success: false,
          error: 'Image not found'
        });
      }
      
      // Delete from storage if path exists
      if (imageData.image_path) {
        const { error: storageError } = await supabase
          .storage
          .from('ingredient-images')
          .remove([imageData.image_path]);
        
        if (storageError) {
          console.error('Error deleting from storage:', storageError);
        }
      }
      
      // Delete from database
      const { error: deleteError } = await supabase
        .from('ingredient_images')
        .delete()
        .eq('id', id);
      
      if (deleteError) {
        console.error('Error deleting from database:', deleteError);
        throw deleteError;
      }
      
      res.json({
        success: true,
        message: 'Image deleted successfully'
      });
      
    } catch (error) {
      console.error('Error in deleteImage:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to delete ingredient image'
      });
    }
  },
  
  // Batch match multiple ingredients
  async batchMatch(req, res) {
    try {
      const { ingredients } = req.body;
      
      if (!ingredients || !Array.isArray(ingredients)) {
        return res.status(400).json({
          success: false,
          error: 'Ingredients array is required'
        });
      }
      
      const supabase = getSupabaseClient();
      const results = [];
      
      // Process each ingredient
      for (const ingredient of ingredients) {
        const { data, error } = await supabase
          .rpc('match_ingredient_image', { search_term: ingredient });
        
        if (!error && data && data.length > 0) {
          results.push({
            ingredient,
            ...data[0]
          });
        } else {
          results.push({
            ingredient,
            image_url: null,
            match_score: 0
          });
        }
      }
      
      res.json({
        success: true,
        data: results
      });
      
    } catch (error) {
      console.error('Error in batchMatch:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to match ingredients'
      });
    }
  }
};

module.exports = {
  ingredientImagesController,
  upload
};