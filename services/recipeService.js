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
   * @param {string} path - API path
   * @param {number} timeout - Request timeout in ms (default 10000)
   */
  makeApiRequest(path, timeout = 10000) {
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

      req.setTimeout(timeout, () => {
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
   * Detect if extracted recipe content is actually a bot protection page
   * Returns true if the recipe looks like bot protection garbage
   */
  detectBotProtection(recipe) {
    if (!recipe) return false;

    const botIndicators = {
      titleKeywords: ['verify', 'human', 'captcha', 'access denied', 'blocked', 'security check', 'please wait', 'checking your browser', 'just a moment'],
      ingredientKeywords: ['browser', 'cookies', 'javascript', 'blocked', 'denied', 'automation', 'enable', 'disabled'],
      knownServices: ['perimeterx', 'cloudflare', 'recaptcha', 'ddos', 'akamai', 'incapsula']
    };

    // Check title
    const titleLower = (recipe.title || '').toLowerCase();
    if (botIndicators.titleKeywords.some(k => titleLower.includes(k))) {
      console.log(`🤖 [WebExtract] Bot protection detected in title: "${recipe.title}"`);
      return true;
    }

    // Check ingredients for error messages
    const ingredients = recipe.extendedIngredients || [];
    for (const ing of ingredients) {
      const text = (ing.original || ing.name || '').toLowerCase();
      if (botIndicators.ingredientKeywords.some(k => text.includes(k))) {
        console.log(`🤖 [WebExtract] Bot protection detected in ingredient: "${text}"`);
        return true;
      }
      if (botIndicators.knownServices.some(k => text.includes(k))) {
        console.log(`🤖 [WebExtract] Bot protection service detected: "${text}"`);
        return true;
      }
    }

    // Check if there are no real instructions (bot pages typically have 0 steps)
    const steps = recipe.analyzedInstructions?.[0]?.steps || [];
    if (ingredients.length > 0 && steps.length === 0) {
      // Check if ingredients look like error messages
      const suspiciousIngredients = ingredients.filter(ing => {
        const text = (ing.original || ing.name || '').toLowerCase();
        return text.includes('access') || text.includes('denied') || text.includes('reference id');
      });
      if (suspiciousIngredients.length > 2) {
        console.log(`🤖 [WebExtract] Bot protection detected: suspicious ingredients with no instructions`);
        return true;
      }
    }

    return false;
  }

  /**
   * Try to extract recipe from Wayback Machine archive
   * @param {string} url - Original URL to find in archive
   * @returns {object} - Recipe data from archived version
   */
  async extractFromWaybackMachine(url) {
    console.log(`🕰️ [WebExtract] Checking Wayback Machine for: ${url}`);

    try {
      // Check for available snapshots
      const availabilityUrl = `https://archive.org/wayback/available?url=${encodeURIComponent(url)}`;

      const response = await new Promise((resolve, reject) => {
        const https = require('https');
        https.get(availabilityUrl, (res) => {
          let data = '';
          res.on('data', chunk => data += chunk);
          res.on('end', () => {
            try {
              resolve(JSON.parse(data));
            } catch (e) {
              reject(new Error('Failed to parse Wayback response'));
            }
          });
        }).on('error', reject);
      });

      if (!response.archived_snapshots?.closest?.url) {
        throw new Error('No archived version available');
      }

      const archivedUrl = response.archived_snapshots.closest.url;
      const snapshotDate = response.archived_snapshots.closest.timestamp;
      console.log(`🕰️ [WebExtract] Found archive from ${snapshotDate}: ${archivedUrl}`);

      // Extract from archived version - skip bot check to avoid infinite loop
      const recipe = await this.extractRecipeFromUrl(archivedUrl, { skipBotCheck: true });

      // Mark that this came from archive
      recipe._fromWaybackMachine = true;
      recipe._archiveDate = snapshotDate;

      return recipe;
    } catch (error) {
      console.error(`❌ [WebExtract] Wayback Machine failed:`, error.message);
      throw error;
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
      const path = `/recipes/${recipeId}/information?includeNutrition=true&apiKey=${apiKey}`;
      
      const recipe = await this.makeApiRequest(path);
      
      return recipe;
    } catch (error) {
      console.error(`Error fetching recipe details for ID ${recipeId}:`, error);
      throw new Error(`Failed to fetch recipe details: ${error.message}`);
    }
  }

  /**
   * Extract recipe from any website URL using Spoonacular
   * @param {string} url - The recipe page URL
   * @param {object} options - Options for extraction
   * @param {boolean} options.skipBotCheck - Skip bot protection check (for Wayback URLs)
   * @returns {object} Extracted recipe data matching saved_recipes schema
   */
  async extractRecipeFromUrl(url, options = {}) {
    const apiKey = process.env.SPOONACULAR_API_KEY;
    if (!apiKey || apiKey === 'your-api-key-here') {
      throw new Error('Spoonacular API key not configured');
    }

    try {
      console.log(`🌐 [WebExtract] Extracting recipe from URL: ${url}`);

      const path = `/recipes/extract?url=${encodeURIComponent(url)}&analyze=true&apiKey=${apiKey}`;

      // Use 30 second timeout - extract endpoint needs to fetch external pages
      const recipe = await this.makeApiRequest(path, 30000);

      if (!recipe || !recipe.title) {
        throw new Error('No recipe found at this URL');
      }

      console.log(`✅ [WebExtract] Successfully extracted: ${recipe.title}`);
      console.log(`📝 [WebExtract] Ingredients: ${recipe.extendedIngredients?.length || 0}`);
      console.log(`📝 [WebExtract] Instructions: ${recipe.analyzedInstructions?.[0]?.steps?.length || 0} steps`);

      // Check for bot protection (unless skipped for Wayback URLs)
      if (!options.skipBotCheck && this.detectBotProtection(recipe)) {
        console.log(`⚠️ [WebExtract] Bot protection detected, trying fallbacks...`);

        // Fallback 1: Try Wayback Machine
        try {
          console.log(`🕰️ [WebExtract] Trying Wayback Machine...`);
          return await this.extractFromWaybackMachine(url);
        } catch (waybackError) {
          console.error(`❌ [WebExtract] Wayback Machine failed:`, waybackError.message);
        }

        // Fallback 2: Try AI direct fetch
        try {
          console.log(`🤖 [WebExtract] Trying AI direct fetch...`);
          const RecipeAIExtractor = require('./recipeAIExtractor');
          const recipeAI = new RecipeAIExtractor();
          const aiResult = await recipeAI.extractFromWebUrl(url);

          // Check if AI result is also bot-blocked
          if (this.detectBotProtection(aiResult)) {
            throw new Error('AI extraction also blocked');
          }

          console.log(`✅ [WebExtract] AI direct fetch successful: ${aiResult.title}`);
          aiResult._extractionMethod = 'ai_fallback';
          return aiResult;
        } catch (aiError) {
          console.error(`❌ [WebExtract] AI direct fetch failed:`, aiError.message);
        }

        // All fallbacks failed
        throw new Error('BOT_PROTECTION_DETECTED: This website has bot protection and no archived version is available. Please try a different recipe URL or add the recipe manually.');
      }

      return recipe;
    } catch (error) {
      console.error(`❌ [WebExtract] Extraction failed:`, error.message);
      // Pass through BOT_PROTECTION_DETECTED errors without wrapping
      if (error.message.includes('BOT_PROTECTION_DETECTED')) {
        throw error;
      }
      throw new Error(`Recipe extraction failed: ${error.message}`);
    }
  }

  /**
   * Get bulk recipe information for multiple recipe IDs
   */
  async getRecipeDetailsBulk(recipeIds) {
    const apiKey = process.env.SPOONACULAR_API_KEY;
    if (!apiKey || apiKey === 'your-api-key-here') {
      throw new Error('Spoonacular API key not configured');
    }

    if (!recipeIds || recipeIds.length === 0) {
      return [];
    }

    try {
      // Spoonacular bulk endpoint accepts comma-separated IDs
      const ids = recipeIds.join(',');
      const path = `/recipes/informationBulk?ids=${ids}&includeNutrition=true&apiKey=${apiKey}`;
      
      console.log(`📚 Fetching bulk recipe details for ${recipeIds.length} recipes`);
      
      const recipes = await this.makeApiRequest(path);
      
      return recipes;
    } catch (error) {
      console.error(`Error fetching bulk recipe details:`, error);
      throw new Error(`Failed to fetch bulk recipe details: ${error.message}`);
    }
  }

  /**
   * Check if a recipe has valid instructions
   */
  hasInstructions(recipe) {
    // Check for instructions in multiple formats
    if (recipe.instructions && recipe.instructions.length > 50) {
      // Has text instructions with reasonable length
      return true;
    }
    
    if (recipe.analyzedInstructions && 
        Array.isArray(recipe.analyzedInstructions) && 
        recipe.analyzedInstructions.length > 0) {
      // Check if there are actual steps in the analyzed instructions
      const hasSteps = recipe.analyzedInstructions.some(section => 
        section.steps && Array.isArray(section.steps) && section.steps.length > 0
      );
      return hasSteps;
    }
    
    return false;
  }

  /**
   * Filter recipes to only include those with instructions
   */
  async filterRecipesWithInstructions(recipes) {
    if (!recipes || recipes.length === 0) {
      return [];
    }

    const requestId = Math.random().toString(36).substring(7);
    console.log(`🔍 [${requestId}] Filtering ${recipes.length} recipes for instructions...`);

    try {
      // Extract recipe IDs
      const recipeIds = recipes.map(r => r.id);
      
      // Fetch detailed information for all recipes
      const detailedRecipes = await this.getRecipeDetailsBulk(recipeIds);
      
      // Create a map for quick lookup
      const detailsMap = new Map();
      detailedRecipes.forEach(recipe => {
        detailsMap.set(recipe.id, recipe);
      });
      
      // Filter recipes that have instructions
      const recipesWithInstructions = recipes.filter(recipe => {
        const details = detailsMap.get(recipe.id);
        if (!details) {
          console.log(`⚠️ [${requestId}] No details found for recipe ${recipe.id}: ${recipe.title}`);
          return false;
        }
        
        const hasInstr = this.hasInstructions(details);
        if (!hasInstr) {
          console.log(`❌ [${requestId}] No instructions for recipe ${recipe.id}: ${recipe.title}`);
        }
        return hasInstr;
      });
      
      console.log(`✅ [${requestId}] ${recipesWithInstructions.length} of ${recipes.length} recipes have instructions`);
      
      return recipesWithInstructions;
    } catch (error) {
      console.error(`❌ [${requestId}] Error filtering recipes:`, error);
      // Return original recipes if filtering fails
      return recipes;
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

      // Step 1: Get user's inventory (or use demo inventory for tour mode)
      console.log(`📦 [${requestId}] Step 1: Fetching user inventory...`);

      let inventory;

      // Check if demo inventory is provided (welcome tour mode)
      if (options.demoInventory && Array.isArray(options.demoInventory) && options.demoInventory.length > 0) {
        console.log(`🎯 [${requestId}] Using demo inventory for tour mode (${options.demoInventory.length} items)`);
        inventory = options.demoInventory;
      } else {
        // Fetch real inventory from database
        inventory = await this.getUserInventory(userId);
      }

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
      
      // Step 4: Filter recipes with instructions
      console.log(`📝 [${requestId}] Step 4: Filtering recipes with instructions...`);
      const recipesWithInstructions = await this.filterRecipesWithInstructions(recipes);
      
      if (recipesWithInstructions.length === 0) {
        console.log(`⚠️  [${requestId}] No recipes with instructions found`);
        return [];
      }
      
      // Step 5: Calculate match scores and format
      console.log(`🧮 [${requestId}] Step 5: Calculating match scores...`);
      const recipeSuggestions = recipesWithInstructions.map(recipe => {
        const matchScore = this.calculateMatchScore(recipe, prioritizedIngredients);
        return this.formatRecipeForFrontend(recipe, matchScore, prioritizedIngredients);
      });
      
      // Step 6: Sort by match score
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