const https = require('https');

class TastyService {
  constructor() {
    this.baseUrl = 'tasty.p.rapidapi.com';
    // Don't cache credentials - read them fresh each time
  }

  makeRequest(path, apiKey) {
    return new Promise((resolve, reject) => {
      const options = {
        hostname: this.baseUrl,
        path: path,
        method: 'GET',
        headers: {
          'X-RapidAPI-Key': apiKey,
          'X-RapidAPI-Host': this.baseUrl
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

  async searchRecipesByIngredients(ingredients, options = {}) {
    // Read credentials fresh each time
    const apiKey = process.env.RAPIDAPI_KEY;
    
    if (!apiKey) {
      console.error('Tasty credentials missing');
      throw new Error('Tasty API key not configured');
    }
    
    const { number = 20 } = options;
    
    // Build smart query from ingredients
    const query = this.buildSmartQuery(ingredients);
    
    // Build path with query parameters
    const params = new URLSearchParams({
      from: 0,
      size: number,
      q: query
    });

    const path = `/recipes/list?${params}`;
    
    console.log(`🍳 Tasty API: Searching with query: ${query}`);
    
    try {
      const response = await this.makeRequest(path, apiKey);
      const transformed = this.transformToSpoonacularFormat(response.results || [], ingredients);
      
      // Return up to the requested number
      return transformed.slice(0, number);
    } catch (error) {
      console.error('Tasty API error:', error);
      throw error;
    }
  }

  buildSmartQuery(ingredients) {
    // Prioritize main ingredients (proteins, produce)
    const prioritized = this.prioritizeIngredients(ingredients);
    
    // Take top 5 ingredients for query
    const queryIngredients = prioritized.slice(0, 5);
    
    // Join with spaces for Tasty search
    return queryIngredients.join(' ');
  }

  prioritizeIngredients(ingredients) {
    const proteins = ['chicken', 'beef', 'pork', 'fish', 'salmon', 'shrimp', 'tofu', 'eggs'];
    const mains = ['pasta', 'rice', 'potato', 'bread'];
    
    const sorted = ingredients.sort((a, b) => {
      const aIsProtein = proteins.some(p => a.toLowerCase().includes(p));
      const bIsProtein = proteins.some(p => b.toLowerCase().includes(p));
      const aIsMain = mains.some(m => a.toLowerCase().includes(m));
      const bIsMain = mains.some(m => b.toLowerCase().includes(m));
      
      if (aIsProtein && !bIsProtein) return -1;
      if (!aIsProtein && bIsProtein) return 1;
      if (aIsMain && !bIsMain) return -1;
      if (!aIsMain && bIsMain) return 1;
      
      return 0;
    });
    
    return sorted;
  }

  transformToSpoonacularFormat(tastyRecipes, userIngredients) {
    return tastyRecipes.map(recipe => {
      const { used, missed } = this.calculateIngredientMatches(recipe, userIngredients);
      const matchPercentage = this.calculateMatchPercentage(used, missed, recipe);
      
      return {
        // Core fields to match Spoonacular format
        id: recipe.id,
        title: recipe.name || 'Untitled Recipe',
        image: recipe.thumbnail_url || recipe.beauty_url || '',
        
        // Video is unique to Tasty!
        video_url: recipe.video_url || null,
        
        // Ingredient matching
        usedIngredientCount: used.length,
        missedIngredientCount: missed.length,
        matchPercentage: matchPercentage,
        
        // Additional Tasty data
        cookTime: recipe.cook_time_minutes || recipe.total_time_minutes || 30,
        servings: recipe.num_servings || 4,
        
        // Instructions
        instructions: this.extractInstructions(recipe),
        
        // Used and missed ingredients
        usedIngredients: used,
        missedIngredients: missed,
        
        // Nutrition if available
        nutrition: recipe.nutrition || {},
        
        // Tasty-specific fields
        userRatings: recipe.user_ratings || {},
        tags: recipe.tags ? recipe.tags.map(t => t.display_name) : [],
        
        // Source indicator
        source: 'tasty'
      };
    });
  }

  calculateIngredientMatches(recipe, userIngredients) {
    const recipeIngredients = this.extractRecipeIngredients(recipe);
    const userIngredientsLower = userIngredients.map(i => i.toLowerCase());
    
    const used = [];
    const missed = [];
    
    recipeIngredients.forEach(recipeIng => {
      const ingName = recipeIng.toLowerCase();
      const isMatch = userIngredientsLower.some(userIng => 
        this.fuzzyMatch(ingName, userIng)
      );
      
      if (isMatch) {
        used.push(recipeIng);
      } else {
        // Check if it's a pantry item we can ignore
        if (!this.isPantryStaple(ingName)) {
          missed.push(recipeIng);
        }
      }
    });
    
    return { used, missed };
  }

  extractRecipeIngredients(recipe) {
    const ingredients = [];
    
    // Tasty stores ingredients in sections
    if (recipe.sections) {
      recipe.sections.forEach(section => {
        if (section.components) {
          section.components.forEach(component => {
            // Extract the main ingredient name
            const ingredient = component.ingredient?.name || 
                              component.raw_text || 
                              '';
            if (ingredient) {
              ingredients.push(ingredient);
            }
          });
        }
      });
    }
    
    return ingredients;
  }

  extractInstructions(recipe) {
    const instructions = [];
    
    if (recipe.instructions) {
      recipe.instructions.forEach(instruction => {
        instructions.push(instruction.display_text || '');
      });
    }
    
    return instructions.filter(i => i.length > 0);
  }

  fuzzyMatch(recipeIngredient, userIngredient) {
    const recipe = recipeIngredient.toLowerCase();
    const user = userIngredient.toLowerCase();
    
    // Direct match
    if (recipe.includes(user) || user.includes(recipe)) {
      return true;
    }
    
    // Handle plurals and common variations
    const singular = user.replace(/s$/, '');
    if (recipe.includes(singular)) {
      return true;
    }
    
    // Handle specific cases
    const mappings = {
      'chicken': ['chicken breast', 'chicken thigh', 'chicken wings'],
      'beef': ['ground beef', 'beef steak', 'beef roast'],
      'tomato': ['tomatoes', 'cherry tomatoes', 'roma tomatoes'],
      'cheese': ['cheddar', 'mozzarella', 'parmesan']
    };
    
    for (const [key, values] of Object.entries(mappings)) {
      if (user.includes(key) && values.some(v => recipe.includes(v))) {
        return true;
      }
      if (recipe.includes(key) && values.some(v => user.includes(v))) {
        return true;
      }
    }
    
    return false;
  }

  isPantryStaple(ingredient) {
    const staples = [
      'salt', 'pepper', 'oil', 'water', 'sugar', 'flour',
      'baking powder', 'baking soda', 'vanilla', 'butter'
    ];
    
    return staples.some(staple => ingredient.includes(staple));
  }

  calculateMatchPercentage(used, missed, recipe) {
    // Get total non-pantry ingredients
    const totalIngredients = this.extractRecipeIngredients(recipe).filter(
      ing => !this.isPantryStaple(ing.toLowerCase())
    ).length;
    
    if (totalIngredients === 0) return 0;
    
    // Calculate percentage
    const percentage = (used.length / totalIngredients) * 100;
    
    // Boost score if recipe has video (unique Tasty feature)
    const videoBonus = recipe.video_url ? 5 : 0;
    
    return Math.min(100, Math.round(percentage + videoBonus));
  }

  // Method to generate a numeric ID from Tasty's ID (if needed)
  generateNumericId(tastyId) {
    if (typeof tastyId === 'number') return tastyId;
    
    // Convert string ID to number if needed
    let hash = 0;
    const str = String(tastyId);
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32-bit integer
    }
    return Math.abs(hash);
  }
}

module.exports = new TastyService();