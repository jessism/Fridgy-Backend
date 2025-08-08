const { createClient } = require('@supabase/supabase-js');
const jwt = require('jsonwebtoken');

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
      
      // Fetch all non-deleted items for the user
      const { data: items, error } = await supabase
        .from('fridge_items')
        .select('*')
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
        quantity: item.quantity.toString(),
        expiryDate: item.expiration_date,
        status: calculateItemStatus(item.expiration_date, item.quantity),
        uploadedAt: item.uploaded_at,
        createdAt: item.created_at
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
  }
};

module.exports = inventoryController;