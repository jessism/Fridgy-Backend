const { createClient } = require('@supabase/supabase-js');
const jwt = require('jsonwebtoken');
const { incrementUsageCounter, decrementUsageCounter } = require('../middleware/checkLimits');

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

// Helper function to calculate item status based on expiration date
const calculateItemStatus = (expirationDate, quantity = 1) => {
  const now = new Date();
  const expiry = new Date(expirationDate);
  const daysUntilExpiry = Math.ceil((expiry - now) / (1000 * 60 * 60 * 24));
  
  if (daysUntilExpiry < 0) {
    return 'Expired';
  } else if (daysUntilExpiry <= 3) {
    return 'Expiring Soon';
  } else if (quantity <= 1) {
    return 'Low Stock';
  } else {
    return 'Good';
  }
};

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

// Inventory Controller Functions
const inventoryController = {
  // Create multiple inventory items for authenticated user
  async createItems(req, res) {
    const requestId = Math.random().toString(36).substring(7);
    
    try {
      console.log(`\n📦 ================== CREATE ITEMS START ==================`);
      console.log(`📦 REQUEST ID: ${requestId}`);
      console.log(`📦 Creating inventory items for authenticated user...`);
      
      const { items } = req.body;
      
      // Get user ID from JWT token
      const userId = getUserIdFromToken(req);
      console.log(`📦 [${requestId}] User ID: ${userId}`);
      console.log(`📦 [${requestId}] Items to create: ${items ? items.length : 0}`);
      
      // Validate input
      if (!items || !Array.isArray(items) || items.length === 0) {
        throw new Error('No valid items provided');
      }
      
      console.log(`📦 [${requestId}] Items data:`, items);
      
      const supabase = getSupabaseClient();
      
      // Prepare items for database insertion, ensuring user_id matches JWT token
      const itemsToInsert = items.map((item, index) => {
        const dbItem = {
          user_id: userId, // Always use userId from JWT token for security
          item_name: item.item_name,
          quantity: parseInt(item.quantity) || 1,
          expiration_date: item.expiration_date,
          category: item.category || 'Other',
          weight_equivalent: item.weight_equivalent || item.total_weight_oz || null, // Store weight if provided
          weight_unit: (item.weight_equivalent || item.total_weight_oz) ? 'oz' : null, // Store unit as 'oz' if weight provided
          uploaded_at: new Date().toISOString(),
          created_at: new Date().toISOString()
        };
        
        console.log(`📦 [${requestId}] Item ${index + 1} prepared:`, dbItem);
        if (dbItem.weight_equivalent) {
          console.log(`📦 [${requestId}]   Weight: ${dbItem.weight_equivalent} ${dbItem.weight_unit}`);
        }
        return dbItem;
      });
      
      // Insert all items into database
      const { data: insertedItems, error } = await supabase
        .from('fridge_items')
        .insert(itemsToInsert)
        .select('*');
      
      if (error) {
        console.error(`❌ [${requestId}] Supabase error:`, error);
        throw error;
      }
      
      console.log(`📦 [${requestId}] Successfully created ${insertedItems ? insertedItems.length : 0} items`);
      console.log(`📦 [${requestId}] Inserted items:`, insertedItems);

      // Increment usage counter for each item created
      for (let i = 0; i < insertedItems.length; i++) {
        await incrementUsageCounter(userId, 'grocery_items');
      }
      console.log(`📦 [${requestId}] Usage counter incremented by ${insertedItems.length}`);

      res.json({
        success: true,
        message: `Successfully created ${insertedItems.length} items`,
        savedItems: insertedItems,
        count: insertedItems.length,
        requestId: requestId
      });
      
      console.log(`\n✅ [${requestId}] =============== CREATE ITEMS COMPLETE ===============\n`);
      
    } catch (error) {
      console.error(`\n💥 [${requestId}] ========== CREATE ITEMS ERROR ==========`);
      console.error(`💥 [${requestId}] Error:`, error);
      console.error(`💥 [${requestId}] Error message:`, error.message);
      console.error(`💥 [${requestId}] =============================================\n`);
      
      const statusCode = error.message.includes('token') ? 401 : 
                        error.message.includes('No valid items') ? 400 : 500;
      
      res.status(statusCode).json({
        success: false,
        error: error.message.includes('token') ? 'Authentication required' : 
               error.message.includes('No valid items') ? 'No valid items provided' :
               'Failed to create items',
        requestId: requestId
      });
    }
  },

  // Get all inventory items for authenticated user
  async getInventory(req, res) {
    const requestId = Math.random().toString(36).substring(7);
    
    try {
      console.log(`\n📦 ================== GET INVENTORY START ==================`);
      console.log(`📦 REQUEST ID: ${requestId}`);
      console.log(`📦 Fetching inventory for authenticated user...`);
      
      // Get user ID from JWT token
      const userId = getUserIdFromToken(req);
      console.log(`📦 [${requestId}] User ID: ${userId}`);
      
      const supabase = getSupabaseClient();
      
      // Fetch all non-deleted items for the user with ingredient images
      const { data: items, error } = await supabase
        .from('fridge_items')
        .select(`
          *,
          ingredient_images:ingredient_image_id (
            id,
            ingredient_name,
            image_url,
            thumbnail_url
          )
        `)
        .eq('user_id', userId)
        .is('deleted_at', null) // Only get items that haven't been deleted
        .order('expiration_date', { ascending: true });
      
      if (error) {
        console.error(`❌ [${requestId}] Supabase error:`, error);
        throw error;
      }
      
      console.log(`📦 [${requestId}] Found ${items ? items.length : 0} items`);
      
      // Transform data to match frontend expectations and calculate status
      const formattedItems = items.map(item => ({
        id: item.id,
        category: item.category || 'Other',
        itemName: item.item_name,
        quantity: parseFloat(item.quantity), // Keep as number for proper decimal display
        unit: item.unit || 'pieces', // Include unit information
        expiryDate: item.expiration_date,
        status: calculateItemStatus(item.expiration_date, item.quantity),
        uploadedAt: item.uploaded_at,
        createdAt: item.created_at,
        weightEquivalent: item.weight_equivalent, // Include weight data if available
        weightUnit: item.weight_unit,
        imageUrl: item.image_url || item.ingredient_images?.image_url || null, // Include image URL
        thumbnailUrl: item.ingredient_images?.thumbnail_url || null // Include thumbnail if available
      }));
      
      console.log(`📦 [${requestId}] Formatted items:`, formattedItems);
      
      res.json({
        success: true,
        items: formattedItems,
        count: formattedItems.length,
        requestId: requestId
      });
      
      console.log(`\n✅ [${requestId}] =============== GET INVENTORY COMPLETE ===============\n`);
      
    } catch (error) {
      console.error(`\n💥 [${requestId}] ========== GET INVENTORY ERROR ==========`);
      console.error(`💥 [${requestId}] Error:`, error);
      console.error(`💥 [${requestId}] Error message:`, error.message);
      console.error(`💥 [${requestId}] =============================================\n`);
      
      const statusCode = error.message.includes('token') ? 401 : 500;
      
      res.status(statusCode).json({
        success: false,
        error: error.message.includes('token') ? 'Authentication required' : 'Failed to fetch inventory',
        requestId: requestId
      });
    }
  },

  // Update specific inventory item
  async updateItem(req, res) {
    const requestId = Math.random().toString(36).substring(7);
    
    try {
      console.log(`\n📝 ================== UPDATE ITEM START ==================`);
      console.log(`📝 REQUEST ID: ${requestId}`);
      
      const { id } = req.params;
      const { item_name, quantity, expiration_date, category } = req.body;
      
      // Get user ID from JWT token
      const userId = getUserIdFromToken(req);
      console.log(`📝 [${requestId}] User ID: ${userId}, Item ID: ${id}`);
      
      const supabase = getSupabaseClient();
      
      // Update the item (only if it belongs to the user)
      const { data: updatedItem, error } = await supabase
        .from('fridge_items')
        .update({
          item_name: item_name,
          quantity: parseInt(quantity) || 1,
          expiration_date: expiration_date,
          category: category,
          updated_at: new Date().toISOString()
        })
        .eq('id', id)
        .eq('user_id', userId) // Ensure user can only update their own items
        .select('*')
        .single();
      
      if (error) {
        console.error(`❌ [${requestId}] Supabase error:`, error);
        throw error;
      }
      
      if (!updatedItem) {
        throw new Error('Item not found or access denied');
      }
      
      console.log(`📝 [${requestId}] Updated item:`, updatedItem);
      
      res.json({
        success: true,
        message: 'Item updated successfully',
        item: updatedItem,
        requestId: requestId
      });
      
      console.log(`\n✅ [${requestId}] =============== UPDATE ITEM COMPLETE ===============\n`);
      
    } catch (error) {
      console.error(`\n💥 [${requestId}] ========== UPDATE ITEM ERROR ==========`);
      console.error(`💥 [${requestId}] Error:`, error);
      console.error(`💥 [${requestId}] ================================================\n`);
      
      const statusCode = error.message.includes('token') ? 401 : 
                        error.message.includes('not found') ? 404 : 500;
      
      res.status(statusCode).json({
        success: false,
        error: error.message,
        requestId: requestId
      });
    }
  },

  // Soft delete specific inventory item with analytics
  async deleteItem(req, res) {
    const requestId = Math.random().toString(36).substring(7);
    
    try {
      console.log(`\n🗑️ ================== SOFT DELETE ITEM START ==================`);
      console.log(`🗑️ REQUEST ID: ${requestId}`);
      
      const { id } = req.params;
      const { deleteReason } = req.body;
      
      // Get user ID from JWT token
      const userId = getUserIdFromToken(req);
      console.log(`🗑️ [${requestId}] User ID: ${userId}, Item ID: ${id}`);
      console.log(`🗑️ [${requestId}] Delete Reason: ${deleteReason}`);
      
      // Validate delete reason
      const validReasons = ['mistake', 'used_up', 'thrown_away'];
      if (!deleteReason || !validReasons.includes(deleteReason)) {
        throw new Error(`Invalid delete reason. Must be one of: ${validReasons.join(', ')}`);
      }
      
      const supabase = getSupabaseClient();
      
      // Soft delete: Update the item with deleted_at and delete_reason (only if it belongs to the user)
      const { data: deletedItem, error } = await supabase
        .from('fridge_items')
        .update({
          deleted_at: new Date().toISOString(),
          delete_reason: deleteReason,
          updated_at: new Date().toISOString()
        })
        .eq('id', id)
        .eq('user_id', userId) // Ensure user can only delete their own items
        .is('deleted_at', null) // Only update if not already deleted
        .select('*')
        .single();
      
      if (error) {
        console.error(`❌ [${requestId}] Supabase error:`, error);
        throw error;
      }
      
      if (!deletedItem) {
        throw new Error('Item not found, already deleted, or access denied');
      }
      
      console.log(`🗑️ [${requestId}] Soft deleted item:`, deletedItem);

      // Decrement usage counter
      await decrementUsageCounter(userId, 'grocery_items');
      console.log(`🗑️ [${requestId}] Usage counter decremented`);

      res.json({
        success: true,
        message: 'Item deleted successfully',
        deletedItem: deletedItem,
        analytics: {
          deletedAt: deletedItem.deleted_at,
          deleteReason: deletedItem.delete_reason
        },
        requestId: requestId
      });
      
      console.log(`\n✅ [${requestId}] =============== SOFT DELETE COMPLETE ===============\n`);
      
    } catch (error) {
      console.error(`\n💥 [${requestId}] ========== SOFT DELETE ERROR ==========`);
      console.error(`💥 [${requestId}] Error:`, error);
      console.error(`💥 [${requestId}] ===============================================\n`);
      
      const statusCode = error.message.includes('token') ? 401 : 
                        error.message.includes('not found') || error.message.includes('already deleted') ? 404 : 
                        error.message.includes('Invalid delete reason') ? 400 : 500;
      
      res.status(statusCode).json({
        success: false,
        error: error.message,
        requestId: requestId
      });
    }
  },

  // Validate if inventory can support requested serving size
  async validateServingSize(req, res) {
    const requestId = Math.random().toString(36).substring(7);
    
    try {
      console.log(`\n🔍 ============== SERVING SIZE VALIDATION START ==============`);
      console.log(`🔍 REQUEST ID: ${requestId}`);
      
      const requestedServings = parseInt(req.query.servings) || 1;
      
      // Get user ID from JWT token
      const userId = getUserIdFromToken(req);
      console.log(`🔍 [${requestId}] User ID: ${userId}, Requested Servings: ${requestedServings}`);
      
      const supabase = getSupabaseClient();
      
      // Get user's current inventory
      const { data: inventory, error: inventoryError } = await supabase
        .from('fridge_items')
        .select('*')
        .eq('user_id', userId);
      
      if (inventoryError) {
        console.error(`❌ [${requestId}] Inventory fetch error:`, inventoryError);
        throw inventoryError;
      }
      
      console.log(`🔍 [${requestId}] Found ${inventory?.length || 0} inventory items`);
      
      // Estimate maximum realistic servings based on inventory
      const maxRealisticServings = estimateMaxServingsFromInventory(inventory || []);
      const isRealistic = requestedServings <= maxRealisticServings;
      
      console.log(`🔍 [${requestId}] Max realistic: ${maxRealisticServings}, Requested: ${requestedServings}, Realistic: ${isRealistic}`);
      
      const response = {
        success: true,
        data: {
          requestedServings,
          maxRealisticServings,
          realistic: isRealistic,
          confidence: (inventory?.length || 0) < 3 ? 'low' : 'medium',
          inventoryItemCount: inventory?.length || 0
        },
        requestId: requestId,
        timestamp: new Date().toISOString()
      };
      
      res.json(response);
      
      console.log(`✅ [${requestId}] Serving size validation complete`);
      console.log(`✅ ============== SERVING SIZE VALIDATION END ==============\n`);
      
    } catch (error) {
      console.error(`❌ [${requestId}] Serving size validation error:`, error);
      
      const statusCode = error.message.includes('token') ? 401 : 500;
      
      res.status(statusCode).json({
        success: false,
        error: error.message.includes('token') ? 'Authentication required' : 'Failed to validate serving size',
        requestId: requestId,
        timestamp: new Date().toISOString()
      });
    }
  }
};

// Helper function to estimate maximum realistic servings from inventory
const estimateMaxServingsFromInventory = (inventory) => {
  const totalItems = inventory.length;
  
  // Simple heuristic based on total number of ingredients
  if (totalItems === 0) return 1;      // No ingredients, but allow 1 serving
  if (totalItems <= 2) return 1;       // Very limited ingredients
  if (totalItems <= 4) return 2;       // Few ingredients  
  if (totalItems <= 6) return 3;       // Decent ingredients
  if (totalItems <= 8) return 4;       // Good variety
  if (totalItems <= 10) return 5;      // Great variety
  return Math.min(Math.ceil(totalItems / 2), 6); // Cap at 6 servings max
};

module.exports = inventoryController;