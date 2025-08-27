const { createClient } = require('@supabase/supabase-js');

// Initialize Supabase client
const getSupabaseClient = () => {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_ANON_KEY;
  
  if (!supabaseUrl || !supabaseKey) {
    throw new Error('Supabase configuration missing');
  }
  
  return createClient(supabaseUrl, supabaseKey);
};

const inventoryDeductionService = {
  /**
   * Deduct ingredients from inventory after meal consumption
   * @param {String} userId - User ID
   * @param {Array} consumedIngredients - Ingredients to deduct
   * @param {String} imageUrl - URL of the meal photo (optional)
   * @param {String} mealType - Type of meal: breakfast, lunch, dinner, or snack (optional)
   * @param {Date} logDate - Target date to log the meal (optional, defaults to current date)
   * @param {String} mealName - Name of the meal (optional)
   * @returns {Promise<Object>} Deduction results
   */
  async deductFromInventory(userId, consumedIngredients, imageUrl = null, mealType = null, logDate = null, mealName = null) {
    const supabase = getSupabaseClient();
    const deductionResults = [];
    const errors = [];

    try {
      // Get user's current inventory
      const { data: inventory, error: inventoryError } = await supabase
        .from('fridge_items')
        .select('*')
        .eq('user_id', userId);

      if (inventoryError) {
        throw inventoryError;
      }

      console.log(`📦 Processing deduction for ${consumedIngredients.length} ingredients`);

      for (const ingredient of consumedIngredients) {
        const result = await this.processIngredientDeduction(
          supabase,
          userId,
          ingredient,
          inventory
        );
        
        if (result.success) {
          deductionResults.push(result);
        } else {
          errors.push(result);
        }
      }

      // Log the transaction with image URL, meal type, target date, and meal name
      await this.logMealTransaction(supabase, userId, consumedIngredients, deductionResults, imageUrl, mealType, logDate, mealName);

      return {
        success: true,
        deducted: deductionResults,
        errors: errors,
        summary: {
          totalIngredients: consumedIngredients.length,
          successfulDeductions: deductionResults.length,
          failedDeductions: errors.length
        }
      };

    } catch (error) {
      console.error('❌ Inventory deduction error:', error);
      throw error;
    }
  },

  /**
   * Process deduction for a single ingredient
   */
  async processIngredientDeduction(supabase, userId, ingredient, inventory) {
    try {
      // Find matching inventory item
      const match = this.findBestMatch(ingredient, inventory);
      
      if (!match) {
        return {
          success: false,
          ingredient: ingredient.name,
          reason: 'Not found in inventory',
          suggestion: 'Add to shopping list'
        };
      }

      // Calculate deduction amount
      const deductionAmount = this.calculateDeductionAmount(
        ingredient.quantity,
        ingredient.unit,
        match.quantity,
        match.unit
      );

      // Check if sufficient quantity available
      if (deductionAmount > match.quantity) {
        return {
          success: false,
          ingredient: ingredient.name,
          reason: 'Insufficient quantity',
          available: match.quantity,
          required: deductionAmount,
          suggestion: 'Partial deduction applied'
        };
      }

      // Update inventory quantity
      const newQuantity = Math.max(0, match.quantity - deductionAmount);
      
      const { data: updated, error: updateError } = await supabase
        .from('fridge_items')
        .update({ 
          quantity: newQuantity,
          updated_at: new Date().toISOString()
        })
        .eq('id', match.id)
        .select()
        .single();

      if (updateError) {
        throw updateError;
      }

      // Delete item if quantity reaches 0
      if (newQuantity === 0) {
        await supabase
          .from('fridge_items')
          .delete()
          .eq('id', match.id);
      }

      return {
        success: true,
        ingredient: ingredient.name,
        itemId: match.id,
        itemName: match.item_name,
        previousQuantity: match.quantity,
        deducted: deductionAmount,
        newQuantity: newQuantity,
        unit: match.unit || ingredient.unit
      };

    } catch (error) {
      console.error(`Error deducting ${ingredient.name}:`, error);
      return {
        success: false,
        ingredient: ingredient.name,
        reason: 'Deduction failed',
        error: error.message
      };
    }
  },

  /**
   * Find the best matching inventory item for an ingredient
   */
  findBestMatch(ingredient, inventory) {
    // Priority 1: Exact name match
    let match = inventory.find(item => 
      item.item_name.toLowerCase() === ingredient.name.toLowerCase()
    );

    if (match) return match;

    // Priority 2: Partial name match
    match = inventory.find(item => 
      item.item_name.toLowerCase().includes(ingredient.name.toLowerCase()) ||
      ingredient.name.toLowerCase().includes(item.item_name.toLowerCase())
    );

    if (match) return match;

    // Priority 3: Category match with expiry priority
    if (ingredient.category) {
      const categoryMatches = inventory
        .filter(item => 
          item.category?.toLowerCase() === ingredient.category.toLowerCase()
        )
        .sort((a, b) => {
          // Sort by expiration date (use items expiring soon first)
          const dateA = new Date(a.expiration_date || '9999-12-31');
          const dateB = new Date(b.expiration_date || '9999-12-31');
          return dateA - dateB;
        });

      if (categoryMatches.length > 0) {
        return categoryMatches[0];
      }
    }

    return null;
  },

  /**
   * Calculate the amount to deduct, handling unit conversions
   */
  calculateDeductionAmount(requiredQty, requiredUnit, availableQty, availableUnit) {
    // Simple conversion logic (can be expanded)
    const conversions = {
      'cup': { 'oz': 8, 'ml': 237, 'tbsp': 16, 'tsp': 48 },
      'oz': { 'cup': 0.125, 'ml': 29.57, 'g': 28.35 },
      'tbsp': { 'tsp': 3, 'ml': 15, 'cup': 0.0625 },
      'lb': { 'oz': 16, 'g': 453.6, 'kg': 0.4536 },
      'kg': { 'g': 1000, 'lb': 2.205, 'oz': 35.27 }
    };

    // If units match, return the required quantity
    if (requiredUnit === availableUnit || !availableUnit) {
      return requiredQty;
    }

    // Try to convert
    if (conversions[requiredUnit] && conversions[requiredUnit][availableUnit]) {
      return requiredQty * conversions[requiredUnit][availableUnit];
    }

    // If no conversion available, use proportional deduction (20% of available)
    return Math.min(requiredQty, availableQty * 0.2);
  },

  /**
   * Log the meal transaction for history
   */
  async logMealTransaction(supabase, userId, ingredients, results, imageUrl = null, mealType = null, logDate = null, mealName = null) {
    try {
      // Use provided logDate or current date as fallback
      const mealDate = logDate ? logDate.toISOString() : new Date().toISOString();
      
      console.log('🔍 Attempting to insert meal log with:');
      console.log('   - user_id:', userId);
      console.log('   - user_id type:', typeof userId);
      console.log('   - meal_type:', mealType);
      console.log('   - meal_name:', mealName);
      console.log('   - meal_photo_url:', imageUrl);
      console.log('   - imageUrl type:', typeof imageUrl);
      console.log('   - imageUrl length:', imageUrl ? imageUrl.length : 0);
      console.log('   - ingredients count:', ingredients?.length);
      
      const { data, error } = await supabase
        .from('meal_logs')
        .insert({
          user_id: userId,
          meal_name: mealName,  // Save the meal name
          meal_photo_url: imageUrl,  // Save the image URL
          meal_type: mealType,  // Save the meal type
          ingredients_detected: ingredients,
          ingredients_logged: ingredients,  // Store the actual ingredients instead of deduction results
          logged_at: mealDate,  // Use target date instead of current date
          created_at: new Date().toISOString()  // created_at is always current time
        })
        .select();

      if (error) {
        console.error('Failed to log meal transaction:', error);
        throw new Error(`Failed to save meal log: ${error.message}`);
      }

      console.log('✅ Meal log saved successfully');
      console.log('   - Saved meal_photo_url:', data?.[0]?.meal_photo_url);
      console.log('   - Saved meal_name:', data?.[0]?.meal_name);

      return data;
    } catch (error) {
      console.error('Error logging meal transaction:', error);
      throw error;  // Re-throw the error so it propagates up
    }
  }
};

module.exports = inventoryDeductionService;