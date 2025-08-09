const https = require('https');
const { createClient } = require('@supabase/supabase-js');

// Helper function to get Supabase client (matches the pattern used in other files)
const getSupabaseClient = () => {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_ANON_KEY;
  
  if (!supabaseUrl || !supabaseKey) {
    throw new Error('Supabase configuration missing');
  }
  
  return createClient(supabaseUrl, supabaseKey);
};

// Recipe Service for Spoonacular API integration
class RecipeService {
  constructor() {
    this.baseUrl = 'api.spoonacular.com';
  }

  /**
   * Make HTTPS request to Spoonacular API
   */
  makeApiRequest(path) {
    return new Promise((resolve, reject) => {
      const options = {
        hostname: this.baseUrl,
        path: path,
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
        }
      };

      const req = https.request(options, (res) => {
        let data = '';
        
        res.on('data', (chunk) => {
          data += chunk;
        });
        
        res.on('end', () => {
          try {
            if (res.statusCode !== 200) {
              reject(new Error(`API request failed with status ${res.statusCode}: ${data}`));
              return;
            }
            
            const jsonData = JSON.parse(data);
            resolve(jsonData);
          } catch (error) {
            reject(new Error(`Failed to parse JSON: ${error.message}`));
          }
        });
      });

      req.on('error', (error) => {
        reject(error);
      });

      req.setTimeout(10000, () => {
        req.abort();
        reject(new Error('API request timeout'));
      });

      req.end();
    });
  }

  /**
   * Get user's current inventory from database
   */
  async getUserInventory(userId) {
    const requestId = Math.random().toString(36).substring(7);
    
    try {
      console.log(`📦 [${requestId}] Fetching inventory for userId: ${userId}`);
      
      const supabase = getSupabaseClient();
      
      const { data: items, error } = await supabase
        .from('fridge_items')
        .select('item_name, category, quantity, expiration_date')
        .eq('user_id', userId)
        .is('deleted_at', null);

      if (error) {
        console.error(`❌ [${requestId}] Supabase error:`, error);
        throw error;
      }

      console.log(`📦 [${requestId}] Found ${items?.length || 0} inventory items`);
      if (items && items.length > 0) {
        console.log(`📦 [${requestId}] Sample items:`, items.slice(0, 3).map(i => i.item_name));
      }

      return items || [];
    } catch (error) {
      console.error(`❌ [${requestId}] Error fetching user inventory:`, error.message);
      throw new Error('Failed to fetch inventory');
    }
  }

  /**
   * Normalize ingredient names for better API matching
   * This helps match user's inventory items with recipe ingredients
   */
  normalizeIngredientName(itemName) {
    return itemName
      .toLowerCase()
      .replace(/s$/, '') // Remove plural 's'
      .replace(/[^a-z0-9\s]/g, '') // Remove special characters
      .trim();
  }

  /**
   * Calculate days until expiration
   */
  getDaysUntilExpiration(expirationDate) {
    const now = new Date();
    const expiry = new Date(expirationDate);
    return Math.ceil((expiry - now) / (1000 * 60 * 60 * 24));
  }

  /**
   * Filter and prioritize ingredients based on expiration and quantity
   */
  prioritizeIngredients(inventory) {
    return inventory
      .filter(item => {
        const daysUntilExpiry = this.getDaysUntilExpiration(item.expiration_date);
        return daysUntilExpiry >= -1 && item.quantity > 0; // Include items that expire in 1 day or more
      })
      .sort((a, b) => {
        // Prioritize by expiration date (sooner = higher priority)
        const daysA = this.getDaysUntilExpiration(a.expiration_date);
        const daysB = this.getDaysUntilExpiration(b.expiration_date);
        return daysA - daysB;
      })
      .slice(0, 10) // Limit to top 10 ingredients for API efficiency
      .map(item => ({
        ...item,
        normalized_name: this.normalizeIngredientName(item.item_name)
      }));
  }

  /**
   * Search recipes by available ingredients using Spoonacular API
   */
  async searchRecipesByIngredients(ingredients, options = {}) {
    const apiKey = process.env.SPOONACULAR_API_KEY;
    if (!apiKey || apiKey === 'your-api-key-here') {
      throw new Error('Spoonacular API key not configured');
    }

    const {
      number = 12, // Number of recipes to return
      ranking = 1, // 1 = maximize used ingredients, 2 = minimize missing ingredients
      ignorePantry = true
    } = options;

    try {
      // Convert ingredients array to comma-separated string
      const ingredientList = ingredients.join(',');
      
      const path = `/recipes/findByIngredients?ingredients=${encodeURIComponent(ingredientList)}&number=${number}&ranking=${ranking}&ignorePantry=${ignorePantry}&apiKey=${apiKey}`;
      
      console.log(`🔍 Searching recipes with ingredients: ${ingredientList}`);
      
      const recipes = await this.makeApiRequest(path);
      
      console.log(`✅ Found ${recipes.length} recipes from Spoonacular`);
      
      return recipes;
    } catch (error) {
      console.error('Error searching recipes:', error);
      throw new Error(`Recipe search failed: ${error.message}`);
    }
  }

  /**
   * Get detailed recipe information
   */
  async getRecipeDetails(recipeId) {
    const apiKey = process.env.SPOONACULAR_API_KEY;
    if (!apiKey || apiKey === 'your-api-key-here') {
      throw new Error('Spoonacular API key not configured');
    }

    try {
      const path = `/recipes/${recipeId}/information?includeNutrition=false&apiKey=${apiKey}`;
      
      const recipe = await this.makeApiRequest(path);
      
      return recipe;
    } catch (error) {
      console.error(`Error fetching recipe details for ID ${recipeId}:`, error);
      throw new Error(`Failed to fetch recipe details: ${error.message}`);
    }
  }

  /**
   * Calculate custom ingredient match score
   * This provides more nuanced scoring than Spoonacular's basic counts
   */
  calculateMatchScore(recipe, userIngredients) {
    const totalRequired = recipe.usedIngredientCount + recipe.missedIngredientCount;
    const usedCount = recipe.usedIngredientCount;
    
    if (totalRequired === 0) return 0;
    
    // Base match percentage
    let matchScore = (usedCount / totalRequired) * 100;
    
    // Bonus for having high-quantity ingredients that are used
    const userIngredientMap = new Map();
    userIngredients.forEach(item => {
      userIngredientMap.set(item.normalized_name, item);
    });
    
    // Check if used ingredients align with user's high-quantity items
    if (recipe.usedIngredients) {
      recipe.usedIngredients.forEach(ingredient => {
        const normalizedName = this.normalizeIngredientName(ingredient.name);
        const userItem = userIngredientMap.get(normalizedName);
        
        if (userItem && userItem.quantity > 2) {
          matchScore += 5; // Bonus for high-quantity matches
        }
      });
    }
    
    // Penalty for many missing ingredients
    const missingPenalty = Math.min(recipe.missedIngredientCount * 2, 20);
    matchScore = Math.max(0, matchScore - missingPenalty);
    
    return Math.round(Math.min(matchScore, 100));
  }

  /**
   * Format recipe data for frontend consumption
   */
  formatRecipeForFrontend(recipe, matchScore, userIngredients) {
    return {
      id: recipe.id,
      title: recipe.title,
      image: recipe.image ? recipe.image.replace('-312x231.jpg', '-636x393.jpg').replace('-312x231.webp', '-636x393.jpg') : 'https://via.placeholder.com/400x300?text=No+Image',
      matchPercentage: matchScore,
      usedIngredientCount: recipe.usedIngredientCount,
      missedIngredientCount: recipe.missedIngredientCount,
      usedIngredients: recipe.usedIngredients?.map(ing => ({
        name: ing.name,
        amount: ing.amount,
        unit: ing.unit,
        image: ing.image
      })) || [],
      missedIngredients: recipe.missedIngredients?.map(ing => ({
        name: ing.name,
        amount: ing.amount,
        unit: ing.unit,
        image: ing.image
      })) || [],
      // Additional fields for recipe cards
      cookingTime: null, // Will be populated from detailed API call if needed
      difficulty: null,
      inStock: matchScore > 70 // Mark as "in stock" if match is high
    };
  }

  /**
   * Main method to get recipe suggestions for a user
   */
  async getRecipeSuggestions(userId, options = {}) {
    const requestId = Math.random().toString(36).substring(7);
    
    try {
      console.log(`\n🍽️  ================ RECIPE SUGGESTIONS START ================`);
      console.log(`🍽️  REQUEST ID: ${requestId}`);
      console.log(`🍽️  Getting suggestions for user: ${userId}`);
      
      // Step 1: Get user's inventory
      console.log(`📦 [${requestId}] Step 1: Fetching user inventory...`);
      const inventory = await this.getUserInventory(userId);
      
      if (inventory.length === 0) {
        console.log(`⚠️  [${requestId}] No inventory items found for user`);
        return [];
      }
      
      console.log(`📦 [${requestId}] Found ${inventory.length} inventory items`);
      
      // Step 2: Prioritize ingredients
      console.log(`🔄 [${requestId}] Step 2: Prioritizing ingredients...`);
      const prioritizedIngredients = this.prioritizeIngredients(inventory);
      const ingredientNames = prioritizedIngredients.map(item => item.item_name);
      
      console.log(`🥘 [${requestId}] Using ingredients: ${ingredientNames.join(', ')}`);
      
      // Step 3: Search recipes
      console.log(`🔍 [${requestId}] Step 3: Searching recipes...`);
      const recipes = await this.searchRecipesByIngredients(ingredientNames, options);
      
      if (recipes.length === 0) {
        console.log(`⚠️  [${requestId}] No recipes found`);
        return [];
      }
      
      // Step 4: Calculate match scores and format
      console.log(`🧮 [${requestId}] Step 4: Calculating match scores...`);
      const recipeSuggestions = recipes.map(recipe => {
        const matchScore = this.calculateMatchScore(recipe, prioritizedIngredients);
        return this.formatRecipeForFrontend(recipe, matchScore, prioritizedIngredients);
      });
      
      // Step 5: Sort by match score
      recipeSuggestions.sort((a, b) => b.matchPercentage - a.matchPercentage);
      
      console.log(`✅ [${requestId}] Generated ${recipeSuggestions.length} recipe suggestions`);
      console.log(`🍽️  ================ RECIPE SUGGESTIONS COMPLETE ================\n`);
      
      return recipeSuggestions;
      
    } catch (error) {
      console.error(`\n💥 [${requestId}] ========== RECIPE SUGGESTIONS ERROR ==========`);
      console.error(`💥 [${requestId}] Error:`, error);
      console.error(`💥 [${requestId}] ================================================\n`);
      
      throw error;
    }
  }
}

module.exports = new RecipeService();