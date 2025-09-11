const https = require('https');

class TastyService {
  constructor() {
    this.baseUrl = 'tasty.p.rapidapi.com';
    // Don't cache credentials - read them fresh each time
    
    // In-memory cache for recipe details
    this.recipeCache = new Map();
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
      
      // Cache raw recipe data for details lookup
      if (response.results) {
        response.results.forEach(recipe => {
          if (recipe.id) {
            this.cacheRecipe(recipe.id, recipe);
          }
        });
      }
      
      const transformed = this.transformToSpoonacularFormat(response.results || [], ingredients);
      
      // FIXED: Apply aggressive filtering to only return achievable recipes
      const filtered = this.filterAchievableRecipes(transformed, ingredients);
      
      console.log(`📊 Tasty filtering results: ${response.results?.length || 0} raw → ${transformed.length} transformed → ${filtered.length} achievable`);
      
      // Return up to the requested number
      return filtered.slice(0, number);
    } catch (error) {
      console.error('Tasty API error:', error);
      throw error;
    }
  }

  buildSmartQuery(ingredients) {
    // Prioritize main ingredients (proteins, produce)
    const prioritized = this.prioritizeIngredients(ingredients);
    
    // FIXED: Limit to 2-3 main ingredients for more targeted results
    // This prevents overly broad searches that return unachievable recipes
    const maxIngredients = prioritized.length >= 3 ? 3 : Math.max(1, prioritized.length);
    const queryIngredients = prioritized.slice(0, maxIngredients);
    
    console.log(`🔍 Tasty query strategy: Using ${queryIngredients.length} of ${ingredients.length} ingredients: ${queryIngredients.join(', ')}`);
    
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
    const recipeSingular = recipe.replace(/s$/, '');
    if (recipe.includes(singular) || recipeSingular.includes(user)) {
      return true;
    }
    
    // FIXED: Enhanced ingredient synonym mapping for better matching
    const mappings = {
      // Proteins - expanded coverage
      'chicken': ['chicken breast', 'chicken thigh', 'chicken wings', 'rotisserie chicken', 'chicken drumsticks', 'boneless chicken'],
      'beef': ['ground beef', 'beef steak', 'beef roast', 'stewing beef', 'beef chuck', 'sirloin', 'ribeye'],
      'pork': ['pork chops', 'pork tenderloin', 'bacon', 'ham', 'pork shoulder', 'ground pork'],
      'fish': ['salmon', 'tuna', 'cod', 'tilapia', 'halibut', 'sea bass', 'white fish'],
      'eggs': ['egg', 'whole eggs', 'egg whites', 'large eggs'],
      
      // Vegetables - common variations
      'tomato': ['tomatoes', 'cherry tomatoes', 'roma tomatoes', 'plum tomatoes', 'grape tomatoes', 'diced tomatoes', 'crushed tomatoes'],
      'onion': ['onions', 'yellow onion', 'white onion', 'red onion', 'sweet onion', 'diced onion'],
      'potato': ['potatoes', 'russet potatoes', 'red potatoes', 'yukon potatoes', 'baby potatoes', 'new potatoes'],
      'pepper': ['bell pepper', 'bell peppers', 'red pepper', 'green pepper', 'yellow pepper', 'sweet pepper'],
      'carrot': ['carrots', 'baby carrots', 'diced carrots', 'shredded carrots'],
      'mushroom': ['mushrooms', 'button mushrooms', 'cremini mushrooms', 'portobello mushrooms', 'shiitake mushrooms'],
      
      // Dairy & Cheese
      'cheese': ['cheddar', 'mozzarella', 'parmesan', 'swiss', 'provolone', 'gouda', 'feta', 'cream cheese'],
      'milk': ['whole milk', '2% milk', 'skim milk', 'low-fat milk'],
      'butter': ['unsalted butter', 'salted butter', 'stick butter'],
      
      // Grains & Starches
      'rice': ['white rice', 'brown rice', 'jasmine rice', 'basmati rice', 'long grain rice', 'cooked rice'],
      'pasta': ['spaghetti', 'penne', 'rigatoni', 'fusilli', 'linguine', 'fettuccine', 'macaroni'],
      'bread': ['white bread', 'whole wheat bread', 'sandwich bread', 'bread slices', 'loaf bread'],
      
      // Herbs & Seasonings (common fresh/dried variations)
      'basil': ['fresh basil', 'dried basil', 'basil leaves'],
      'oregano': ['fresh oregano', 'dried oregano'],
      'thyme': ['fresh thyme', 'dried thyme'],
      'parsley': ['fresh parsley', 'flat-leaf parsley', 'italian parsley'],
      'cilantro': ['fresh cilantro', 'cilantro leaves', 'coriander'],
      'garlic': ['garlic cloves', 'fresh garlic', 'minced garlic', 'garlic powder']
    };
    
    // Enhanced bidirectional matching
    for (const [key, values] of Object.entries(mappings)) {
      // User has general ingredient, recipe specifies specific type
      if (user.includes(key) && values.some(v => recipe.includes(v))) {
        return true;
      }
      // Recipe has general ingredient, user has specific type
      if (recipe.includes(key) && values.some(v => user.includes(v))) {
        return true;
      }
      // Cross-matching within the same category
      const userMatches = values.filter(v => user.includes(v));
      const recipeMatches = values.filter(v => recipe.includes(v));
      if (userMatches.length > 0 && recipeMatches.length > 0) {
        return true;
      }
    }
    
    // Handle common word order differences
    const userWords = user.split(' ').filter(w => w.length > 2);
    const recipeWords = recipe.split(' ').filter(w => w.length > 2);
    
    // If 2+ words match, consider it a match
    const matchingWords = userWords.filter(uw => recipeWords.some(rw => rw.includes(uw) || uw.includes(rw)));
    if (matchingWords.length >= 2) {
      return true;
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
    
    // FIXED: Improved scoring that heavily favors achievable recipes
    let percentage = (used.length / totalIngredients) * 100;
    
    // Heavy penalty for missing ingredients (this is the key change)
    const missingPenalty = missed.length * 15; // 15% penalty per missing ingredient
    percentage = Math.max(0, percentage - missingPenalty);
    
    // Bonus for high ingredient match ratio
    const matchRatio = used.length / Math.max(1, used.length + missed.length);
    if (matchRatio >= 0.8) percentage += 20; // Big bonus for 80%+ match
    else if (matchRatio >= 0.6) percentage += 10; // Medium bonus for 60%+ match
    
    // Boost score if recipe has video (unique Tasty feature) - but only for good matches
    const videoBonus = (recipe.video_url && percentage > 40) ? 5 : 0;
    
    // Extra bonus for using multiple user ingredients effectively
    const ingredientUsageBonus = Math.min(used.length * 3, 15); // Up to 15% bonus
    
    const finalScore = Math.min(100, Math.round(percentage + videoBonus + ingredientUsageBonus));
    
    console.log(`🧮 ${recipe.name || 'Recipe'}: Used ${used.length}, Missing ${missed.length}, Base ${Math.round(percentage)}%, Final ${finalScore}%`);
    
    return finalScore;
  }

  /**
   * FIXED: Check if user has essential ingredients required for the recipe type
   * This prevents impossible recipes like "Chicken Sandwich" when user has no chicken
   */
  hasEssentialIngredients(recipe, userIngredients) {
    const recipeTitle = (recipe.title || recipe.name || '').toLowerCase();
    
    // Define essential ingredient patterns - if recipe title matches pattern, user MUST have the essential ingredient
    const essentialPatterns = {
      'chicken': [
        'chicken sandwich', 'chicken burger', 'chicken wrap', 'chicken salad', 
        'chicken tacos', 'chicken curry', 'chicken stir fry', 'chicken soup',
        'fried chicken', 'grilled chicken', 'chicken wings', 'chicken breast',
        'chicken thighs', 'chicken rice', 'chicken pasta', 'chicken bowl'
      ],
      'beef': [
        'beef stew', 'beef sandwich', 'hamburger', 'beef curry', 'beef tacos',
        'beef stir fry', 'beef soup', 'ground beef', 'beef rice', 'beef pasta',
        'steak', 'roast beef', 'beef bowl', 'meat sauce'
      ],
      'pork': [
        'pork chops', 'pork sandwich', 'bacon sandwich', 'pork tacos',
        'pork stir fry', 'pork curry', 'pulled pork', 'pork rice', 'pork bowl'
      ],
      'fish': [
        'fish tacos', 'fish sandwich', 'fish curry', 'fish soup', 'fish bowl',
        'salmon', 'tuna', 'cod', 'fish fillet', 'grilled fish', 'fried fish'
      ],
      'bread': [
        'sandwich', 'burger', 'toast', 'french toast', 'bread pudding',
        'garlic bread', 'breadcrumbs', 'stuffing', 'croutons'
      ],
      'pasta': [
        'spaghetti', 'penne', 'lasagna', 'pasta salad', 'fettuccine',
        'linguine', 'rigatoni', 'macaroni', 'pasta bake', 'carbonara',
        'bolognese', 'pasta sauce', 'pasta dish'
      ],
      'rice': [
        'fried rice', 'rice bowl', 'risotto', 'rice pilaf', 'rice salad',
        'spanish rice', 'rice pudding', 'rice dish', 'rice and beans'
      ],
      'eggs': [
        'scrambled eggs', 'fried eggs', 'omelet', 'egg salad', 'egg sandwich',
        'deviled eggs', 'egg drop soup', 'french toast', 'quiche', 'egg dish'
      ]
    };
    
    // Convert user ingredients to lowercase for matching
    const userIngredientsLower = userIngredients.map(ing => ing.toLowerCase());
    
    // Check each essential ingredient pattern
    for (const [essential, patterns] of Object.entries(essentialPatterns)) {
      // If recipe title matches any pattern for this essential ingredient
      if (patterns.some(pattern => recipeTitle.includes(pattern))) {
        
        // Check if user has this essential ingredient (using fuzzy matching)
        const hasEssential = userIngredientsLower.some(userIngredient => 
          this.fuzzyMatch(essential, userIngredient) || 
          userIngredient.includes(essential) || 
          essential.includes(userIngredient)
        );
        
        // Special handling for bread variations
        const hasBreadVariation = essential === 'bread' && userIngredientsLower.some(userIngredient =>
          userIngredient.includes('bun') || userIngredient.includes('roll') || 
          userIngredient.includes('toast') || userIngredient.includes('bagel') ||
          userIngredient.includes('pita') || userIngredient.includes('wrap') ||
          userIngredient.includes('tortilla') || userIngredient.includes('flatbread')
        );
        
        if (!hasEssential && !hasBreadVariation) {
          console.log(`❌ ${recipe.title || recipe.name}: Missing essential ingredient '${essential}' for recipe type`);
          return false; // Filter out completely - impossible to make
        }
      }
    }
    
    return true; // Has all essential ingredients
  }

  /**
   * FIXED: Filter recipes to only include those the user can reasonably make
   * This is the key fix that makes Tasty work like Spoonacular's ingredient-based filtering
   */
  filterAchievableRecipes(recipes, userIngredients) {
    console.log(`🔍 Filtering ${recipes.length} recipes for achievability...`);
    
    const filtered = recipes.filter(recipe => {
      // NEW: Rule 0 - Must have essential ingredients (prevents impossible recipes)
      if (!this.hasEssentialIngredients(recipe, userIngredients)) {
        return false; // Already logged in hasEssentialIngredients method
      }
      
      // Rule 1: Must have at least 30% ingredient match
      if (recipe.matchPercentage < 30) {
        console.log(`❌ ${recipe.title}: Low match (${recipe.matchPercentage}%)`);
        return false;
      }
      
      // Rule 2: Cannot have more than 3 missing non-pantry ingredients
      if (recipe.missedIngredientCount > 3) {
        console.log(`❌ ${recipe.title}: Too many missing ingredients (${recipe.missedIngredientCount})`);
        return false;
      }
      
      // Rule 3: Must use at least 1 user ingredient
      if (recipe.usedIngredientCount === 0) {
        console.log(`❌ ${recipe.title}: Uses no user ingredients`);
        return false;
      }
      
      // Rule 4: Missing ingredient ratio cannot exceed 60%
      const totalNonPantry = recipe.usedIngredientCount + recipe.missedIngredientCount;
      const missingRatio = totalNonPantry > 0 ? (recipe.missedIngredientCount / totalNonPantry) : 1;
      if (missingRatio > 0.6) {
        console.log(`❌ ${recipe.title}: Too many missing (${Math.round(missingRatio * 100)}% missing)`);
        return false;
      }
      
      console.log(`✅ ${recipe.title}: Match ${recipe.matchPercentage}%, Missing ${recipe.missedIngredientCount}/${totalNonPantry}`);
      return true;
    });
    
    // Sort by match percentage (best matches first)
    return filtered.sort((a, b) => b.matchPercentage - a.matchPercentage);
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

  // Cache recipe details during search
  cacheRecipe(recipeId, recipeData) {
    console.log(`🧪 Caching Tasty recipe: ${recipeId}`);
    console.log(`🧪 IMAGE FIELDS:`, {
      thumbnail_url: recipeData.thumbnail_url,
      thumbnail_alt_text: recipeData.thumbnail_alt_text,
      video_url: recipeData.video_url,
      original_video_url: recipeData.original_video_url
    });
    console.log(`🧪 INGREDIENTS:`, {
      sections: recipeData.sections ? recipeData.sections.length : 'null',
      sampleSection: recipeData.sections?.[0]
    });
    console.log(`🧪 INSTRUCTIONS:`, {
      instructions: recipeData.instructions ? recipeData.instructions.length : 'null',
      sampleInstruction: recipeData.instructions?.[0]
    });
    this.recipeCache.set(String(recipeId), recipeData);
  }

  // Get cached recipe details
  async getRecipeDetails(recipeId) {
    console.log(`🧪 Fetching Tasty recipe details for ID: ${recipeId}`);
    
    const cachedRecipe = this.recipeCache.get(String(recipeId));
    
    if (cachedRecipe) {
      console.log(`🧪 Found cached recipe: ${cachedRecipe.title}`);
      return this.formatRecipeDetails(cachedRecipe);
    } else {
      console.log(`🧪 Recipe ${recipeId} not found in cache`);
      throw new Error(`Recipe ${recipeId} not found in cache. Recipe details must be fetched during search.`);
    }
  }

  // Extract ingredients from Tasty API response
  extractIngredients(recipe) {
    let ingredients = [];
    
    // Try multiple possible ingredient structures in Tasty API
    if (recipe.sections && Array.isArray(recipe.sections)) {
      // Method 1: sections.components structure
      ingredients = recipe.sections.flatMap(section => 
        section.components?.map(component => ({
          id: component.id || Math.random(),
          name: component.ingredient?.name || component.raw_text || 'Unknown ingredient',
          amount: component.measurements?.[0]?.quantity || 1,
          unit: component.measurements?.[0]?.unit?.name || 'piece',
          original: component.raw_text || component.ingredient?.name
        })) || []
      );
    } else if (recipe.recipe && recipe.recipe.sections) {
      // Method 2: nested recipe.sections
      ingredients = recipe.recipe.sections.flatMap(section => 
        section.components?.map(component => ({
          id: component.id || Math.random(),
          name: component.ingredient?.name || component.raw_text || 'Unknown ingredient',
          amount: component.measurements?.[0]?.quantity || 1,
          unit: component.measurements?.[0]?.unit?.name || 'piece',
          original: component.raw_text || component.ingredient?.name
        })) || []
      );
    } else if (recipe.ingredients && Array.isArray(recipe.ingredients)) {
      // Method 3: direct ingredients array
      ingredients = recipe.ingredients.map((ingredient, index) => ({
        id: index,
        name: ingredient.name || ingredient,
        amount: ingredient.amount || 1,
        unit: ingredient.unit || 'piece',
        original: ingredient.raw_text || ingredient.name || ingredient
      }));
    }
    
    return ingredients;
  }

  // Format recipe details for frontend compatibility
  formatRecipeDetails(recipe) {
    return {
      // Core fields matching Spoonacular format
      id: recipe.id,
      title: recipe.name || recipe.title,
      image: recipe.thumbnail_url || recipe.thumbnail_alt_text || recipe.image,
      summary: recipe.description || `Delicious ${recipe.name || recipe.title} recipe with video instructions.`,
      
      // Instructions (key difference from Spoonacular)
      instructions: recipe.instructions || [],
      analyzedInstructions: recipe.instructions ? [
        {
          name: "",
          steps: recipe.instructions.map((instruction, index) => ({
            number: index + 1,
            step: instruction.display_text || instruction
          }))
        }
      ] : [],
      
      // Ingredients - fix mapping for Tasty API structure
      ingredients: this.extractIngredients(recipe),
      extendedIngredients: this.extractIngredients(recipe),
      
      // Basic info
      readyInMinutes: recipe.total_time_minutes || 30,
      servings: recipe.num_servings || 4,
      
      // Tasty-specific features
      video: recipe.video_url ? {
        videoUrl: recipe.video_url,
        thumbnailUrl: recipe.thumbnail_url || recipe.image
      } : null,
      
      // Nutrition (if available)
      nutrition: recipe.nutrition ? {
        nutrients: [
          { name: 'Calories', amount: recipe.nutrition.calories || 0, unit: 'kcal' },
          { name: 'Fat', amount: recipe.nutrition.fat || 0, unit: 'g' },
          { name: 'Carbohydrates', amount: recipe.nutrition.carbohydrates || 0, unit: 'g' },
          { name: 'Protein', amount: recipe.nutrition.protein || 0, unit: 'g' }
        ]
      } : null,
      
      // Additional metadata
      dishTypes: recipe.tags?.map(tag => tag.name) || [],
      cuisines: recipe.cuisine ? [recipe.cuisine] : [],
      
      // Source info
      sourceUrl: recipe.original_video_url || recipe.video_url,
      sourceName: "Tasty",
      
      // Internal tracking
      _source: 'tasty',
      _hasVideo: !!recipe.video_url,
      _cached: true
    };
  }
}

module.exports = new TastyService();