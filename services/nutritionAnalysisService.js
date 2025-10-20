const fetch = require('node-fetch');

class NutritionAnalysisService {
  constructor() {
    this.apiKey = process.env.OPENROUTER_API_KEY;
    // Use stable model that's confirmed working
    this.model = 'google/gemini-2.0-flash-001'; // Stable model
    this.fallbackModel = 'google/gemini-flash-1.5-8b'; // Paid fallback
  }

  /**
   * Analyze recipe ingredients to estimate nutrition information
   * @param {Object} recipe - Recipe object with ingredients and servings
   * @returns {Promise<Object>} Nutrition data in Spoonacular format
   */
  async analyzeRecipeNutrition(recipe) {
    try {
      console.log('[NutritionAnalysis] Starting nutrition analysis for:', recipe.title);
      console.log('[NutritionAnalysis] Recipe source type:', recipe.source_type || 'unknown');
      console.log('[NutritionAnalysis] Recipe has extendedIngredients:', !!recipe.extendedIngredients);

      // Extract ingredients for analysis
      const ingredients = this.extractIngredientList(recipe);
      const servings = recipe.servings || 4;

      console.log('[NutritionAnalysis] Extracted ingredients:', {
        count: ingredients.length,
        servings: servings,
        firstIngredient: ingredients[0]
      });

      if (!ingredients || ingredients.length === 0) {
        console.log('[NutritionAnalysis] ❌ No ingredients found to analyze');
        console.log('[NutritionAnalysis] Recipe object keys:', Object.keys(recipe));
        return null;
      }

      // Build AI prompt for nutrition analysis
      const prompt = this.buildNutritionPrompt(recipe.title, ingredients, servings);

      // Call AI for nutrition estimation
      const nutritionData = await this.callAI(prompt);

      if (!nutritionData) {
        console.log('[NutritionAnalysis] Failed to get nutrition data from AI');
        return null;
      }

      // Format nutrition data for frontend
      const formattedNutrition = this.formatNutritionData(nutritionData, servings);

      console.log('[NutritionAnalysis] Nutrition analysis complete:', {
        calories: formattedNutrition.perServing?.calories?.amount,
        protein: formattedNutrition.perServing?.protein?.amount,
        confidence: nutritionData.confidence
      });

      return formattedNutrition;

    } catch (error) {
      console.error('[NutritionAnalysis] Error analyzing nutrition:', error);
      return null;
    }
  }

  /**
   * Extract ingredient list from recipe object
   */
  extractIngredientList(recipe) {
    const ingredients = [];

    // Handle extended ingredients format (from Instagram imports and other sources)
    if (recipe.extendedIngredients && Array.isArray(recipe.extendedIngredients)) {
      console.log('[NutritionAnalysis] Processing extendedIngredients array:', recipe.extendedIngredients.length, 'items');

      recipe.extendedIngredients.forEach((ing, index) => {
        // Handle both object and string formats
        if (typeof ing === 'string') {
          // Simple string ingredient (common in Instagram recipes)
          ingredients.push({
            amount: '',
            unit: '',
            name: ing,
            original: ing
          });
          console.log(`[NutritionAnalysis] Ingredient ${index + 1} (string):`, ing);
        } else if (typeof ing === 'object') {
          // Object format ingredient
          const ingredient = {
            amount: ing.amount || ing.measures?.us?.amount || '',
            unit: ing.unit || ing.measures?.us?.unitShort || '',
            name: ing.name || ing.originalName || ing.nameClean || '',
            original: ing.original || ing.originalString || `${ing.amount || ''} ${ing.unit || ''} ${ing.name || ''}`.trim()
          };

          // Only add if we have at least a name or original text
          if (ingredient.name || ingredient.original) {
            ingredients.push(ingredient);
            console.log(`[NutritionAnalysis] Ingredient ${index + 1} (object):`, ingredient.original);
          }
        }
      });
    } else if (recipe.ingredients && Array.isArray(recipe.ingredients)) {
      // Fallback: handle simple ingredients array
      console.log('[NutritionAnalysis] Processing simple ingredients array:', recipe.ingredients.length, 'items');
      recipe.ingredients.forEach((ing, index) => {
        if (typeof ing === 'string') {
          ingredients.push({
            amount: '',
            unit: '',
            name: ing,
            original: ing
          });
          console.log(`[NutritionAnalysis] Simple ingredient ${index + 1}:`, ing);
        }
      });
    } else {
      console.log('[NutritionAnalysis] No recognizable ingredient format found');
      console.log('[NutritionAnalysis] Recipe keys:', Object.keys(recipe));
    }

    console.log('[NutritionAnalysis] Total ingredients extracted:', ingredients.length);
    return ingredients;
  }

  /**
   * Build prompt for AI nutrition analysis
   */
  buildNutritionPrompt(recipeTitle, ingredients, servings) {
    const ingredientList = ingredients.map(ing =>
      `- ${ing.original || `${ing.amount} ${ing.unit} ${ing.name}`.trim()}`
    ).join('\n');

    return `Analyze the nutrition content of this recipe and provide detailed nutritional estimates.

RECIPE: ${recipeTitle}
SERVINGS: ${servings}

INGREDIENTS:
${ingredientList}

INSTRUCTIONS:
1. Calculate total nutrition for all ingredients combined
2. Divide by ${servings} to get per-serving values
3. Use standard nutritional databases as reference
4. Consider typical preparation methods (cooking oil, water loss, etc.)
5. Be accurate but conservative in estimates

IMPORTANT ESTIMATION GUIDELINES:
- Proteins (meat, fish, tofu): ~25g protein per 100g, ~200-250 cal per 100g
- Vegetables: ~20-40 cal per 100g, 2-3g protein, 5-10g carbs
- Grains/Pasta (cooked): ~130-150 cal per 100g, 3-5g protein, 25-30g carbs
- Dairy: Varies widely, use specific product knowledge
- Oils/Fats: ~120 cal per tablespoon, 14g fat
- Consider cooking methods: grilling/baking adds less calories than frying

Return ONLY a JSON object with this exact structure:
{
  "confidence": 0.0-1.0,
  "totalNutrition": {
    "calories": number,
    "protein": number (grams),
    "carbohydrates": number (grams),
    "fat": number (grams),
    "saturatedFat": number (grams),
    "fiber": number (grams),
    "sugar": number (grams),
    "sodium": number (milligrams),
    "cholesterol": number (milligrams)
  },
  "perServing": {
    "calories": number,
    "protein": number (grams),
    "carbohydrates": number (grams),
    "fat": number (grams),
    "saturatedFat": number (grams),
    "fiber": number (grams),
    "sugar": number (grams),
    "sodium": number (milligrams),
    "cholesterol": number (milligrams)
  },
  "caloricBreakdown": {
    "percentProtein": number (0-100),
    "percentCarbs": number (0-100),
    "percentFat": number (0-100)
  },
  "estimationNotes": "Brief note about estimation accuracy",
  "isEstimated": true
}

The percentages should add up to 100. Calculate them based on:
- Protein: 4 calories per gram
- Carbs: 4 calories per gram
- Fat: 9 calories per gram`;
  }

  /**
   * Call AI API for nutrition analysis
   */
  async callAI(prompt) {
    try {
      console.log('[NutritionAnalysis] Calling AI for nutrition estimation...');

      const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://fridgy.app',
          'X-Title': 'Fridgy Nutrition Analysis'
        },
        body: JSON.stringify({
          model: this.model,
          messages: [{
            role: 'user',
            content: prompt
          }],
          response_format: { type: 'json_object' },
          temperature: 0.2, // Lower temperature for more consistent nutrition estimates
          max_tokens: 1000
        })
      });

      if (!response.ok) {
        const errorData = await response.text();
        console.error('[NutritionAnalysis] AI API error:', response.status);
        console.error('[NutritionAnalysis] Error details:', errorData);

        // Try fallback model if primary model fails
        // No need to check specific model name, just try fallback on any failure
        console.log('[NutritionAnalysis] Primary model failed, trying fallback...');
        try {
          return await this.callAIWithFallback(prompt);
        } catch (fallbackError) {
          console.error('[NutritionAnalysis] Fallback also failed:', fallbackError.message);
          throw new Error(`AI API error: ${response.status}`)
        }
      }

      const data = await response.json();
      const content = data.choices?.[0]?.message?.content;

      if (!content) {
        throw new Error('No response from AI');
      }

      // Parse and validate JSON response
      const nutritionData = JSON.parse(content);

      // Validate required fields
      if (!nutritionData.perServing || !nutritionData.caloricBreakdown) {
        throw new Error('Invalid nutrition data format');
      }

      return nutritionData;

    } catch (error) {
      console.error('[NutritionAnalysis] AI call failed:', error);

      // Return mock data for testing if no API key
      if (!this.apiKey) {
        return this.getMockNutritionData();
      }

      throw error;
    }
  }

  /**
   * Fallback to paid model if free model fails
   */
  async callAIWithFallback(prompt) {
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://fridgy.app',
        'X-Title': 'Fridgy Nutrition Analysis'
      },
      body: JSON.stringify({
        model: this.fallbackModel,
        messages: [{
          role: 'user',
          content: prompt
        }],
        response_format: { type: 'json_object' },
        temperature: 0.2,
        max_tokens: 1000
      })
    });

    if (!response.ok) {
      throw new Error(`Fallback AI API error: ${response.status}`);
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;

    if (!content) {
      throw new Error('No response from fallback AI');
    }

    return JSON.parse(content);
  }

  /**
   * Format nutrition data for frontend consumption
   */
  formatNutritionData(aiData, servings) {
    const perServing = aiData.perServing;

    // Format in Spoonacular-compatible structure
    return {
      perServing: {
        calories: {
          amount: Math.round(perServing.calories || 0),
          unit: 'kcal',
          percentOfDailyNeeds: Math.round((perServing.calories || 0) / 2000 * 100)
        },
        protein: {
          amount: Math.round(perServing.protein || 0),
          unit: 'g',
          percentOfDailyNeeds: Math.round((perServing.protein || 0) / 50 * 100)
        },
        carbohydrates: {
          amount: Math.round(perServing.carbohydrates || 0),
          unit: 'g',
          percentOfDailyNeeds: Math.round((perServing.carbohydrates || 0) / 300 * 100)
        },
        fat: {
          amount: Math.round(perServing.fat || 0),
          unit: 'g',
          percentOfDailyNeeds: Math.round((perServing.fat || 0) / 65 * 100)
        },
        saturatedFat: {
          amount: Math.round(perServing.saturatedFat || 0),
          unit: 'g',
          percentOfDailyNeeds: Math.round((perServing.saturatedFat || 0) / 20 * 100)
        },
        fiber: {
          amount: Math.round(perServing.fiber || 0),
          unit: 'g',
          percentOfDailyNeeds: Math.round((perServing.fiber || 0) / 25 * 100)
        },
        sugar: {
          amount: Math.round(perServing.sugar || 0),
          unit: 'g',
          percentOfDailyNeeds: Math.round((perServing.sugar || 0) / 50 * 100)
        },
        sodium: {
          amount: Math.round(perServing.sodium || 0),
          unit: 'mg',
          percentOfDailyNeeds: Math.round((perServing.sodium || 0) / 2300 * 100)
        },
        cholesterol: {
          amount: Math.round(perServing.cholesterol || 0),
          unit: 'mg',
          percentOfDailyNeeds: Math.round((perServing.cholesterol || 0) / 300 * 100)
        }
      },
      caloricBreakdown: {
        percentProtein: Math.round(aiData.caloricBreakdown?.percentProtein || 0),
        percentFat: Math.round(aiData.caloricBreakdown?.percentFat || 0),
        percentCarbs: Math.round(aiData.caloricBreakdown?.percentCarbs || 0)
      },
      healthScore: this.calculateHealthScore(perServing),
      isAIEstimated: true,
      confidence: aiData.confidence || 0.85,
      estimationNotes: aiData.estimationNotes || 'AI-estimated nutrition information'
    };
  }

  /**
   * Calculate a health score based on nutrition profile
   */
  calculateHealthScore(nutrition) {
    let score = 50; // Base score

    // Positive factors
    if (nutrition.protein > 20) score += 10;
    if (nutrition.fiber > 5) score += 10;

    // Negative factors
    if (nutrition.saturatedFat > 10) score -= 10;
    if (nutrition.sodium > 1000) score -= 10;
    if (nutrition.sugar > 20) score -= 10;

    // Balance check
    if (nutrition.calories > 0 && nutrition.calories < 600) score += 5;

    return Math.max(0, Math.min(100, score));
  }

  /**
   * Get mock nutrition data for testing
   */
  getMockNutritionData() {
    return {
      confidence: 0.75,
      totalNutrition: {
        calories: 1600,
        protein: 80,
        carbohydrates: 120,
        fat: 60,
        saturatedFat: 20,
        fiber: 16,
        sugar: 24,
        sodium: 2400,
        cholesterol: 200
      },
      perServing: {
        calories: 400,
        protein: 20,
        carbohydrates: 30,
        fat: 15,
        saturatedFat: 5,
        fiber: 4,
        sugar: 6,
        sodium: 600,
        cholesterol: 50
      },
      caloricBreakdown: {
        percentProtein: 20,
        percentCarbs: 30,
        percentFat: 50
      },
      estimationNotes: 'Mock data for testing',
      isEstimated: true
    };
  }

  /**
   * Analyze a single ingredient for basic nutrition
   * Useful for ingredient-level nutrition display
   */
  async analyzeIngredient(ingredient, amount, unit) {
    try {
      console.log(`[NutritionAnalysis] Analyzing single ingredient: ${amount} ${unit} ${ingredient}`);

      const prompt = `Estimate the nutrition for: ${amount} ${unit} ${ingredient}

Return ONLY a JSON object:
{
  "calories": number,
  "protein": number (grams),
  "carbohydrates": number (grams),
  "fat": number (grams),
  "confidence": 0.0-1.0
}`;

      const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://fridgy.app',
          'X-Title': 'Fridgy Nutrition Analysis'
        },
        body: JSON.stringify({
          model: this.model,
          messages: [{
            role: 'user',
            content: prompt
          }],
          response_format: { type: 'json_object' },
          temperature: 0.2,
          max_tokens: 500
        })
      });

      if (!response.ok) {
        throw new Error(`AI API error: ${response.status}`);
      }

      const data = await response.json();
      const content = data.choices?.[0]?.message?.content;

      if (!content) {
        throw new Error('No response from AI');
      }

      return JSON.parse(content);

    } catch (error) {
      console.error('[NutritionAnalysis] Failed to analyze ingredient:', error);

      // Return mock data if no API key
      if (!this.apiKey) {
        return {
          calories: 165,
          protein: 31,
          carbohydrates: 0,
          fat: 3.6,
          confidence: 0.75
        };
      }

      return null;
    }
  }
}

module.exports = NutritionAnalysisService;