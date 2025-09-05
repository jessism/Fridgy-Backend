const { createClient } = require('@supabase/supabase-js');

// Ingredient mapping for smart matching
const INGREDIENT_MAPPINGS = {
  // Proteins
  'chicken': ['chicken breast', 'chicken thigh', 'chicken wing', 'chicken drumstick', 'chicken leg', 'poultry', 'chicken tender'],
  'beef': ['steak', 'ground beef', 'beef roast', 'beef chuck', 'sirloin', 'ribeye', 'tenderloin'],
  'pork': ['pork chop', 'bacon', 'ham', 'pork tenderloin', 'pork loin', 'sausage'],
  'fish': ['salmon', 'tuna', 'cod', 'tilapia', 'halibut', 'trout', 'seafood'],
  
  // Vegetables
  'broccoli': ['broccoli floret', 'broccoli crown', 'broccoli stem', 'broccolini'],
  'carrot': ['baby carrot', 'carrot stick', 'carrots'],
  'potato': ['russet potato', 'sweet potato', 'baby potato', 'red potato', 'yukon gold'],
  'tomato': ['cherry tomato', 'roma tomato', 'grape tomato', 'tomatoes'],
  'mushroom': ['shiitake', 'portobello', 'button mushroom', 'cremini', 'mushrooms'],
  'onion': ['red onion', 'white onion', 'yellow onion', 'shallot', 'green onion'],
  
  // Grains & Pasta
  'rice': ['white rice', 'brown rice', 'jasmine rice', 'basmati rice', 'wild rice'],
  'pasta': ['spaghetti', 'penne', 'fusilli', 'macaroni', 'noodles', 'linguine', 'fettuccine'],
  'bread': ['white bread', 'whole wheat bread', 'sourdough', 'baguette', 'roll'],
  
  // Dairy
  'cheese': ['cheddar', 'mozzarella', 'parmesan', 'swiss', 'feta', 'gouda'],
  'milk': ['whole milk', '2% milk', 'skim milk', 'almond milk', 'soy milk'],
};

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
        .eq('user_id', userId)
        .is('deleted_at', null);  // Only get active items, not soft-deleted ones

      if (inventoryError) {
        throw inventoryError;
      }

      console.log(`📦 Processing deduction for ${consumedIngredients.length} ingredients`);

      for (const ingredient of consumedIngredients) {
        const result = await this.processIngredientDeduction(
          supabase,
          userId,
          ingredient,
          inventory,
          mealName  // Pass meal name for logging
        );
        
        if (result.success) {
          deductionResults.push(result);
          // Update user preferences for successful matches
          await this.updateUserPreference(supabase, userId, ingredient.name, result.itemName, result.matchConfidence);
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
  async processIngredientDeduction(supabase, userId, ingredient, inventory, mealName = null) {
    try {
      // Find matching inventory item with user preferences
      const matchResult = await this.findBestMatchWithScore(ingredient, inventory, userId);
      const match = matchResult?.item;
      
      if (!match) {
        return {
          success: false,
          ingredient: ingredient.name,
          reason: 'Not found in inventory',
          suggestion: 'Add to shopping list'
        };
      }

      // Calculate deduction amount with enhanced logic
      const deductionAmount = this.calculateDeductionAmount(
        ingredient.quantity,
        ingredient.unit,
        match.quantity,
        match.unit,
        match  // Pass the full inventory item for weight data
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

      // Update inventory quantity with proper type conversion for DECIMAL fields
      console.log(`📊 Debug - match.quantity type: ${typeof match.quantity}, value: ${match.quantity}`);
      console.log(`📊 Debug - deductionAmount type: ${typeof deductionAmount}, value: ${deductionAmount}`);
      console.log(`📊 Debug - match.id: ${match.id}`);
      
      // Parse quantities to ensure they're numbers (DECIMAL comes as string from DB)
      const currentQty = parseFloat(match.quantity || 0);
      const deductQty = parseFloat(deductionAmount || 0);
      const newQuantity = Math.max(0, currentQty - deductQty);
      
      console.log(`📊 Debug - Calculation: ${currentQty} - ${deductQty} = ${newQuantity}`);
      
      if (isNaN(newQuantity)) {
        console.error('❌ newQuantity is NaN! currentQty:', currentQty, 'deductQty:', deductQty);
        throw new Error('Invalid quantity calculation');
      }
      
      if (!match.id) {
        console.error('❌ Match missing id:', match);
        throw new Error('Invalid inventory item - missing id');
      }
      
      // IMPORTANT: Delete FIRST if quantity reaches 0 (to avoid CHECK constraint violation)
      if (newQuantity === 0) {
        // Delete immediately when depleted
        const { error: deleteError } = await supabase
          .from('fridge_items')
          .delete()
          .eq('id', match.id);
          
        if (deleteError) {
          console.error('❌ Delete failed:', deleteError);
          throw deleteError;
        }
        
        console.log(`🗑️ Item ${match.item_name} depleted and removed from inventory`);
      } else {
        // Only update if quantity > 0
        const { data: updated, error: updateError } = await supabase
          .from('fridge_items')
          .update({ 
            quantity: newQuantity,
            updated_at: new Date().toISOString()
          })
          .eq('id', match.id)
          .select();

        if (updateError) {
          console.error('❌ Update failed:', updateError);
          console.error('   Attempted to update id:', match.id, 'with quantity:', newQuantity);
          throw updateError;
        }
        
        console.log(`✅ Updated ${match.item_name}: ${currentQty} → ${newQuantity}`);
      }

      // Log the usage to inventory_usage table for tracking
      try {
        const { error: usageError } = await supabase
          .from('inventory_usage')
          .insert({
            item_id: match.id,
            user_id: userId,
            amount_used: deductionAmount,
            unit: match.unit || ingredient.unit || 'pieces',
            usage_type: 'meal',
            notes: mealName ? `Used in: ${mealName}` : `Used ${deductionAmount} ${match.unit || 'units'} for ${ingredient.name}`
          });
        
        if (usageError) {
          console.warn('Failed to log usage:', usageError);
          // Don't fail the deduction if usage logging fails
        } else {
          console.log(`📊 Usage logged: ${deductionAmount} ${match.unit || 'units'} of ${match.item_name}`);
        }
      } catch (logError) {
        console.warn('Error logging usage:', logError);
        // Continue even if logging fails
      }

      return {
        success: true,
        ingredient: ingredient.name,
        itemId: match.id,
        itemName: match.item_name,
        previousQuantity: match.quantity,
        deducted: deductionAmount,
        newQuantity: newQuantity,
        unit: match.unit || ingredient.unit,
        matchConfidence: matchResult?.score || 100
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
   * Extract semantic food tokens from ingredient name
   */
  extractFoodTokens(name) {
    if (!name) return [];
    
    // Important food words to preserve
    const preserveWords = new Set([
      'steak', 'ribeye', 'sirloin', 'filet', 'tenderloin', 'porterhouse', 't-bone',
      'chicken', 'beef', 'pork', 'lamb', 'fish', 'salmon', 'tuna', 'shrimp',
      'breast', 'thigh', 'wing', 'drumstick', 'chop', 'loin', 'rib', 'shoulder',
      'ground', 'minced', 'whole', 'fillet', 'cutlet', 'roast', 'brisket'
    ]);
    
    const words = name.toLowerCase()
      .replace(/[,\-\_\.]/g, ' ')
      .split(/\s+/)
      .filter(word => word.length > 1);
    
    // Keep important food words and meaningful descriptors
    return words.filter(word => {
      // Always keep preserved words
      if (preserveWords.has(word)) return true;
      // Keep words longer than 3 chars that aren't common descriptors
      if (word.length > 3 && !['with', 'from', 'made', 'fresh', 'frozen'].includes(word)) return true;
      return false;
    });
  },

  /**
   * Normalize ingredient names - Two-stage approach preserving semantic meaning
   */
  normalizeIngredientName(name) {
    if (!name) return '';
    
    // Stage 1: Light cleaning (preserve core meaning)
    let cleaned = name.toLowerCase()
      // Only remove pure cooking methods, not cuts or parts
      .replace(/\b(cooked|raw|grilled|baked|fried|steamed|boiled|roasted|sautéed|sauteed)\b/gi, '')
      // Only remove pure preparation when not the main descriptor
      .replace(/\b(fresh|frozen|dried|canned)\b/gi, '')
      // Clean up punctuation and extra spaces
      .replace(/[,\-\_\.]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    
    // Stage 2: Extract semantic tokens
    const tokens = this.extractFoodTokens(cleaned);
    
    // Handle common plurals on the token result
    let normalized = tokens.join(' ');
    if (normalized) {
      normalized = normalized
        .replace(/\b(\w+)ies\b/gi, '$1y')  // berries → berry
        .replace(/\b(\w+)ves\b/gi, '$1f')  // leaves → leaf
        .replace(/\b(\w+)oes\b/gi, '$1o')  // tomatoes → tomato
        .replace(/\b(\w+)ches\b/gi, '$1ch') // sandwiches → sandwich
        .replace(/\b(\w+)sses\b/gi, '$1ss') // glasses → glass
        .replace(/\b(\w+)s\b/gi, '$1');     // carrots → carrot
    }
    
    // CRITICAL: Never return empty - fallback to cleaned version
    return normalized || cleaned || name.toLowerCase();
  },

  /**
   * Calculate word overlap score between two strings
   */
  calculateWordOverlap(str1, str2) {
    const words1 = str1.split(' ').filter(w => w.length > 2);
    const words2 = str2.split(' ').filter(w => w.length > 2);
    
    if (words1.length === 0 || words2.length === 0) return 0;
    
    let matchCount = 0;
    for (const word1 of words1) {
      if (words2.includes(word1)) {
        matchCount++;
      }
    }
    
    // Calculate score based on percentage of words matched
    const maxWords = Math.max(words1.length, words2.length);
    return Math.round((matchCount / maxWords) * 75);
  },

  /**
   * Check if ingredients are related through common mappings
   */
  areIngredientsRelated(name1, name2) {
    const norm1 = name1.toLowerCase();
    const norm2 = name2.toLowerCase();
    
    // Check each mapping category
    for (const [baseIngredient, variations] of Object.entries(INGREDIENT_MAPPINGS)) {
      const allTerms = [baseIngredient, ...variations];
      
      // Check if both names are in the same category
      let found1 = false;
      let found2 = false;
      
      for (const term of allTerms) {
        if (norm1.includes(term) || term.includes(norm1)) found1 = true;
        if (norm2.includes(term) || term.includes(norm2)) found2 = true;
      }
      
      if (found1 && found2) return true;
    }
    
    return false;
  },

  /**
   * Get user's preferred match from history
   */
  async getUserPreferredMatch(userId, scannedName, inventory) {
    try {
      const supabase = getSupabaseClient();
      const { data, error } = await supabase
        .from('user_ingredient_matches')
        .select('matched_item_name, confidence_score')
        .eq('user_id', userId)
        .eq('scanned_name', scannedName.toLowerCase())
        .order('confidence_score', { ascending: false })
        .order('match_count', { ascending: false })
        .limit(1)
        .single();
      
      if (data) {
        // Check if the preferred item is in current inventory
        const item = inventory.find(i => i.item_name.toLowerCase() === data.matched_item_name.toLowerCase());
        if (item) {
          return {
            ...item,
            confidence: data.confidence_score
          };
        }
      }
    } catch (error) {
      console.log('No user preference found or error:', error.message);
    }
    return null;
  },

  /**
   * Update user preferences after successful match
   */
  async updateUserPreference(supabase, userId, scannedName, matchedName, confidence) {
    try {
      const { data: existing } = await supabase
        .from('user_ingredient_matches')
        .select('*')
        .eq('user_id', userId)
        .eq('scanned_name', scannedName.toLowerCase())
        .eq('matched_item_name', matchedName.toLowerCase())
        .single();
      
      if (existing) {
        // Update existing preference
        await supabase
          .from('user_ingredient_matches')
          .update({
            match_count: existing.match_count + 1,
            confidence_score: Math.min(100, existing.confidence_score + 5), // Increase confidence
            last_used: new Date().toISOString()
          })
          .eq('id', existing.id);
      } else {
        // Create new preference
        await supabase
          .from('user_ingredient_matches')
          .insert({
            user_id: userId,
            scanned_name: scannedName.toLowerCase(),
            matched_item_name: matchedName.toLowerCase(),
            confidence_score: confidence,
            match_count: 1
          });
      }
    } catch (error) {
      console.log('Failed to update user preference:', error.message);
    }
  },

  /**
   * Find best match and return with score
   */
  async findBestMatchWithScore(ingredient, inventory, userId = null) {
    const match = await this.findBestMatch(ingredient, inventory, userId);
    if (!match) return null;
    
    // Return match with score info
    return {
      item: match,
      score: match.confidence || this.lastMatchScore || 100
    };
  },

  /**
   * Find the best matching inventory item using hierarchical matching strategy
   */
  async findBestMatch(ingredient, inventory, userId = null) {
    console.log(`\n🔍 Attempting to match: "${ingredient.name}"`);
    
    const ingredientLower = ingredient.name.toLowerCase();
    const normalizedIngredient = this.normalizeIngredientName(ingredient.name);
    const ingredientTokens = this.extractFoodTokens(ingredient.name);
    
    console.log(`   📝 Original: "${ingredient.name}"`);
    console.log(`   📝 Normalized: "${normalizedIngredient}"`);
    console.log(`   📝 Tokens: [${ingredientTokens.join(', ')}]`);
    
    // Check user preferences first if userId provided
    if (userId) {
      const userPref = await this.getUserPreferredMatch(userId, ingredient.name, inventory);
      if (userPref) {
        console.log(`   ⭐ Using user preference: "${userPref.item_name}" (confidence: ${userPref.confidence}%)`);
        return userPref;
      }
    }
    
    let bestMatch = null;
    let bestScore = 0;
    let bestMethod = '';
    
    for (const item of inventory) {
      const itemLower = item.item_name.toLowerCase();
      const normalizedItem = this.normalizeIngredientName(item.item_name);
      const itemTokens = this.extractFoodTokens(item.item_name);
      
      // Level 1: Exact match (score: 100)
      if (itemLower === ingredientLower) {
        console.log(`   ✅ EXACT MATCH: "${item.item_name}" (100% confidence)`);
        return item;
      }
      
      // Level 2: One contains the other (score: 85-90)
      // Higher score if the scanned item is contained in inventory item
      if (itemLower.includes(ingredientLower)) {
        const score = 90;
        if (score > bestScore) {
          bestMatch = item;
          bestScore = score;
          bestMethod = 'inventory-contains-scan';
        }
      } else if (ingredientLower.includes(itemLower)) {
        const score = 85;
        if (score > bestScore) {
          bestMatch = item;
          bestScore = score;
          bestMethod = 'scan-contains-inventory';
        }
      }
      
      // Level 3: Normalized match (score: 80)
      if (normalizedItem === normalizedIngredient && normalizedIngredient !== '') {
        const score = 80;
        if (score > bestScore) {
          bestMatch = item;
          bestScore = score;
          bestMethod = 'normalized-match';
        }
      }
      
      // Level 4: Semantic/mapping match (score: 75)
      if (this.areIngredientsRelated(ingredientLower, itemLower)) {
        const score = 75;
        if (score > bestScore) {
          bestMatch = item;
          bestScore = score;
          bestMethod = 'semantic-related';
        }
      }
      
      // Level 5: Token overlap (score: 60-70)
      if (ingredientTokens.length > 0 && itemTokens.length > 0) {
        const commonTokens = ingredientTokens.filter(token => itemTokens.includes(token));
        if (commonTokens.length > 0) {
          // Score based on percentage of tokens matched
          const score = 60 + (10 * commonTokens.length / Math.max(ingredientTokens.length, itemTokens.length));
          if (score > bestScore) {
            bestMatch = item;
            bestScore = Math.round(score);
            bestMethod = `token-overlap(${commonTokens.join(',')})`;
          }
        }
      }
    }
    
    // Level 6: Category fallback (score: 40)
    if (bestScore < 60 && ingredient.category) {
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
        if (40 > bestScore) {
          bestMatch = categoryMatches[0];
          bestScore = 40;
          bestMethod = 'category-fallback';
        }
      }
    }
    
    // Log the result with more detail
    if (bestMatch) {
      console.log(`   ✓ Best match: "${bestMatch.item_name}" (${bestScore}% confidence, method: ${bestMethod})`);
      
      // Log future improvement opportunity
      if (bestScore < 80) {
        console.log(`   💡 Consider storing user preference: "${ingredient.name}" → "${bestMatch.item_name}"`);
      }
    } else {
      console.log(`   ✗ No match found (best score: ${bestScore}%)`);
      console.log(`   💡 Suggest adding "${ingredient.name}" to shopping list`);
    }
    
    // Store the score for later use
    this.lastMatchScore = bestScore;
    
    // Return match if confidence is above threshold (50% lowered from 60%)
    return bestScore >= 50 ? bestMatch : null;
  },

  /**
   * Calculate the amount to deduct with intelligent weight-based conversion
   */
  calculateDeductionAmount(requiredQty, requiredUnit, availableQty, availableUnit, inventoryItem) {
    console.log(`\n💡 Calculating deduction:`);
    console.log(`   Required: ${requiredQty} ${requiredUnit || 'units'} of "${inventoryItem.item_name}"`);
    console.log(`   Available: ${availableQty} ${availableUnit || 'items'} in inventory`);
    
    // If inventory has weight data, use it for smart conversion
    if (inventoryItem.weight_equivalent && inventoryItem.weight_unit === 'oz' && requiredUnit === 'oz') {
      const ozPerPiece = inventoryItem.weight_equivalent / availableQty;
      const piecesNeeded = requiredQty / ozPerPiece;
      
      console.log(`   📊 Using weight data: ${inventoryItem.weight_equivalent}oz total = ${ozPerPiece.toFixed(1)}oz per item`);
      console.log(`   📊 Need ${requiredQty}oz / ${ozPerPiece.toFixed(1)}oz per item = ${piecesNeeded.toFixed(2)} items`);
      console.log(`   📊 Will deduct: ${Math.min(Math.ceil(piecesNeeded), availableQty)} items`);
      
      return Math.min(Math.ceil(piecesNeeded), availableQty);
    }
    
    // Smart defaults by category when weight data not available
    if (requiredUnit === 'oz' && (!availableUnit || availableUnit === 'pieces' || availableUnit === 'items')) {
      const smartDefaults = {
        'protein': 6,    // 1 piece of protein = 6 oz
        'vegetable': 8,  // 1 piece of vegetable = 8 oz
        'fruit': 6,      // 1 piece of fruit = 6 oz
        'grain': 4,      // 1 serving of grain = 4 oz
        'dairy': 8       // 1 serving of dairy = 8 oz
      };
      
      const category = inventoryItem.category?.toLowerCase() || 'protein';
      const ozPerItem = smartDefaults[category] || 6;
      const itemsNeeded = Math.ceil(requiredQty / ozPerItem);
      
      console.log(`   🎯 No weight data, using smart default for ${category}: ${ozPerItem}oz per item`);
      console.log(`   🎯 Need ${requiredQty}oz / ${ozPerItem}oz per item = ${itemsNeeded} items`);
      console.log(`   🎯 Will deduct: ${Math.min(itemsNeeded, availableQty)} items`);
      
      return Math.min(itemsNeeded, availableQty);
    }
    
    // Standard unit conversions
    const conversions = {
      'cup': { 'oz': 8, 'ml': 237, 'tbsp': 16, 'tsp': 48 },
      'oz': { 'cup': 0.125, 'ml': 29.57, 'g': 28.35 },
      'tbsp': { 'tsp': 3, 'ml': 15, 'cup': 0.0625 },
      'lb': { 'oz': 16, 'g': 453.6, 'kg': 0.4536 },
      'kg': { 'g': 1000, 'lb': 2.205, 'oz': 35.27 }
    };
    
    // If units match or no unit specified, direct deduction
    if (requiredUnit === availableUnit || !availableUnit || !requiredUnit) {
      const amount = Math.min(requiredQty, availableQty);
      console.log(`   ✅ Units match or unspecified, deducting: ${amount}`);
      return amount;
    }
    
    // Try standard conversion
    if (conversions[requiredUnit] && conversions[requiredUnit][availableUnit]) {
      const converted = requiredQty * conversions[requiredUnit][availableUnit];
      const amount = Math.min(converted, availableQty);
      console.log(`   🔄 Converted ${requiredQty} ${requiredUnit} to ${converted.toFixed(2)} ${availableUnit}`);
      console.log(`   🔄 Will deduct: ${amount}`);
      return amount;
    }
    
    // Fallback: Always deduct at least 1 item if available
    const fallbackAmount = Math.min(1, availableQty);
    console.log(`   ⚠️ No conversion available, deducting fallback: ${fallbackAmount} item`);
    return fallbackAmount;
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