const https = require('https');

class EdamamService {
  constructor() {
    this.baseUrl = 'api.edamam.com';
    // Don't cache credentials - read them fresh each time
  }

  makeRequest(path) {
    return new Promise((resolve, reject) => {
      const options = {
        hostname: this.baseUrl,
        path: path,
        method: 'GET',
        headers: {
          'Content-Type': 'application/json'
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
    const appId = process.env.EDAMAM_APP_ID;
    const appKey = process.env.EDAMAM_APP_KEY;
    
    if (!appId || !appKey) {
      console.error('Edamam credentials missing:', { appId: !!appId, appKey: !!appKey });
      throw new Error('Edamam API credentials not configured');
    }
    
    // Request more recipes since we'll filter some out
    const { number = 8 } = options;
    const requestNumber = number * 3; // Request 3x more to account for filtering
    
    // Build Edamam query
    const query = ingredients.join(' ');
    const params = new URLSearchParams({
      type: 'public',
      q: query,
      app_id: appId,
      app_key: appKey,
      from: 0,
      to: requestNumber
    });

    const path = `/api/recipes/v2?${params}`;
    
    console.log(`🧪 Edamam API: Searching with ingredients: ${query}`);
    
    try {
      const response = await this.makeRequest(path);
      const transformed = this.transformToSpoonacularFormat(response.hits || [], ingredients);
      
      // Return up to the requested number
      return transformed.slice(0, number);
    } catch (error) {
      console.error('Edamam API error:', error);
      throw error;
    }
  }

  transformToSpoonacularFormat(hits, userIngredients) {
    return hits.map(hit => {
      const recipe = hit.recipe;
      const { used, missed } = this.calculateIngredientMatches(recipe, userIngredients);
      const matchPercentage = this.calculateMatchPercentage(used, missed);
      
      return {
        // Core fields to match Spoonacular format
        id: this.generateNumericId(recipe.uri),
        title: recipe.label,
        image: recipe.image,
        
        // Ingredient matching
        usedIngredientCount: used.length,
        missedIngredientCount: missed.length,
        usedIngredients: used,
        missedIngredients: missed,
        matchPercentage: matchPercentage,
        
        // Recipe details
        readyInMinutes: recipe.totalTime || 30,
        servings: recipe.yield || 4,
        
        // Mark as "in stock" if match is high
        inStock: matchPercentage > 60,
        
        // Instructions - Check if instructionLines exist, otherwise use ingredientLines
        instructions: recipe.instructionLines && recipe.instructionLines.length > 0
          ? recipe.instructionLines.join('\n')
          : recipe.ingredientLines 
            ? `Ingredients:\n${recipe.ingredientLines.join('\n')}\n\nFor full instructions, visit the original recipe.`
            : 'See original recipe for instructions.',
        analyzedInstructions: [{
          name: '',
          steps: recipe.instructionLines && recipe.instructionLines.length > 0
            ? recipe.instructionLines.map((line, index) => ({
                number: index + 1,
                step: line,
                ingredients: [],
                equipment: []
              }))
            : recipe.ingredientLines 
              ? recipe.ingredientLines.map((line, index) => ({
                  number: index + 1,
                  step: line,
                  ingredients: [],
                  equipment: []
                }))
              : []
        }],
        
        // Extended ingredients for modal
        extendedIngredients: recipe.ingredients ? recipe.ingredients.map(ing => ({
          id: Math.random() * 100000,
          name: ing.food,
          original: ing.text || `${ing.quantity} ${ing.measure} ${ing.food}`,
          amount: ing.quantity || 1,
          unit: ing.measure || '',
          image: ing.image || `https://spoonacular.com/cdn/ingredients_100x100/${ing.food}.jpg`
        })) : [],
        
        // Dietary and health labels
        vegetarian: recipe.healthLabels?.includes('Vegetarian') || false,
        vegan: recipe.healthLabels?.includes('Vegan') || false,
        glutenFree: recipe.healthLabels?.includes('Gluten-Free') || false,
        dairyFree: recipe.healthLabels?.includes('Dairy-Free') || false,
        veryHealthy: recipe.healthLabels?.includes('Very Healthy') || false,
        cheap: false,
        veryPopular: false,
        
        // Cuisine and dish types
        cuisines: recipe.cuisineType || [],
        dishTypes: recipe.dishType || recipe.mealType || [],
        
        // Nutrition summary - indicate if instructions are available
        summary: recipe.instructionLines && recipe.instructionLines.length > 0
          ? `${recipe.label} is a ${recipe.dishType?.[0] || 'dish'} with ${Math.round(recipe.calories || 0)} total calories. This recipe serves ${recipe.yield || 4} and takes about ${recipe.totalTime || 30} minutes to prepare.`
          : `${recipe.label} is a ${recipe.dishType?.[0] || 'dish'} with ${Math.round(recipe.calories || 0)} total calories. Serves ${recipe.yield || 4}. Note: Full cooking instructions available at source.`,
        
        // Additional metadata
        sourceUrl: recipe.url,
        creditsText: recipe.source || 'Edamam',
        calories: Math.round((recipe.calories || 0) / (recipe.yield || 4)),
        healthLabels: recipe.healthLabels || [],
        dietLabels: recipe.dietLabels || [],
        _source: 'edamam',
        _edamamUri: recipe.uri
      };
    });
  }

  generateNumericId(uri) {
    // Generate consistent numeric ID from URI for frontend compatibility
    let hash = 0;
    for (let i = 0; i < uri.length; i++) {
      const char = uri.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }
    return Math.abs(hash);
  }

  calculateIngredientMatches(recipe, userIngredients) {
    const used = [];
    const missed = [];
    
    // Normalize user ingredients for better matching
    const normalizedUserIngredients = userIngredients.map(ing => 
      ing.toLowerCase().replace(/s$/, '').trim()
    );
    
    // Process recipe ingredients
    if (recipe.ingredients) {
      recipe.ingredients.forEach(ing => {
        const ingredientName = ing.food.toLowerCase();
        
        // Check if this ingredient matches any user ingredient
        const match = normalizedUserIngredients.find(userIng => 
          ingredientName.includes(userIng) || userIng.includes(ingredientName)
        );
        
        const formattedIngredient = {
          name: ing.food,
          amount: Math.round(ing.quantity * 100) / 100 || 1,
          unit: ing.measure || 'piece',
          image: `https://spoonacular.com/cdn/ingredients_100x100/${ing.food}.jpg`
        };
        
        if (match) {
          used.push(formattedIngredient);
        } else {
          missed.push(formattedIngredient);
        }
      });
    }
    
    return { used, missed };
  }

  calculateMatchPercentage(used, missed) {
    const total = used.length + missed.length;
    if (total === 0) return 0;
    return Math.round((used.length / total) * 100);
  }
}

module.exports = new EdamamService();