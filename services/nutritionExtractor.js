const fetch = require('node-fetch');

/**
 * NutritionExtractor - Extracts nutrition information from Instagram captions/text
 *
 * This service is separate from recipe extraction to avoid interfering with
 * ingredient and instruction extraction. It only runs when nutrition keywords
 * are detected in the caption.
 */
class NutritionExtractor {
  constructor() {
    this.apiKey = process.env.OPENROUTER_API_KEY;
    this.model = 'google/gemini-2.0-flash-001'; // Same model as nutrition analysis
    this.fallbackModel = 'google/gemini-flash-1.5-8b';
  }

  /**
   * Extract nutrition information from Instagram caption or text
   * @param {string} caption - Instagram post caption
   * @returns {Promise<Object|null>} Nutrition data if found, null otherwise
   */
  async extractFromCaption(caption) {
    try {
      console.log('[NutritionExtractor] Checking caption for nutrition information...');

      if (!caption || typeof caption !== 'string') {
        console.log('[NutritionExtractor] No caption provided');
        return null;
      }

      // Quick keyword check to avoid unnecessary AI calls
      const hasNutritionKeywords = this.containsNutritionKeywords(caption);

      if (!hasNutritionKeywords) {
        console.log('[NutritionExtractor] No nutrition keywords found, skipping extraction');
        return null;
      }

      console.log('[NutritionExtractor] Nutrition keywords detected, calling AI...');

      // Build prompt for nutrition extraction only
      const prompt = this.buildNutritionExtractionPrompt(caption);

      // Call AI to extract nutrition
      const result = await this.callAI(prompt);

      if (result && result.found && result.perServing) {
        console.log('[NutritionExtractor] ✅ Successfully extracted nutrition from caption:', {
          calories: result.perServing.calories,
          protein: result.perServing.protein,
          carbs: result.perServing.carbohydrates,
          fat: result.perServing.fat
        });
        return result;
      }

      console.log('[NutritionExtractor] No nutrition data found in caption');
      return null;

    } catch (error) {
      console.error('[NutritionExtractor] Error extracting nutrition:', error.message);
      return null; // Fail gracefully - will fall back to estimation
    }
  }

  /**
   * Check if caption contains nutrition-related keywords
   */
  containsNutritionKeywords(caption) {
    const keywords = [
      /calor(ie)?s?/i,
      /kcal/i,
      /\bcal\b/i,           // "450 cal"
      /macro(s)?/i,
      /protein/i,
      /carb(s|ohydrate)?s?/i,
      /\bfat\b/i,
      /nutrition/i,
      /\d+p\b/i,            // Pattern like "25p" for protein
      /\d+c\b/i,            // Pattern like "30c" for carbs
      /\d+f\b/i,            // Pattern like "12f" for fat
      /per serving/i,
      /\d+\s*g\s*protein/i, // "30g protein" or "30 g protein"
      /\d+\s*g\s*carb/i,    // "40g carbs"
      /\d+\s*g\s*fat/i,     // "15g fat"
      /P:\s*\d+/i,          // "P: 30" or "P:30"
      /C:\s*\d+/i,          // "C: 40"
      /F:\s*\d+/i,          // "F: 15"
      /\d+P\s*\/\s*\d+C/i,  // "25P/40C" format
      /serving.*\d+/i,      // "serving size 200g" or "per serving: 450"
    ];

    return keywords.some(pattern => pattern.test(caption));
  }

  /**
   * Build AI prompt for nutrition extraction
   */
  buildNutritionExtractionPrompt(caption) {
    return `You are extracting ONLY nutrition/macro information from an Instagram post caption.

CAPTION TEXT:
${caption}

TASK:
Look for nutrition information per serving, such as:
- "350 calories per serving"
- "Macros: 25p/30c/12f" (protein/carbs/fat in grams)
- "Each has 400 cal, 20g protein, 35g carbs, 15g fat"
- "Nutrition per serving: 450 kcal, 30g protein, 40g carbs, 18g fat"
- Comments mentioning macros or nutrition

IMPORTANT:
- ONLY extract if explicitly mentioned in the text
- DO NOT estimate or calculate
- If multiple servings mentioned, extract per-serving values
- If no nutrition is found, set "found": false

Return ONLY this JSON structure:
{
  "found": true or false,
  "perServing": {
    "calories": number or null,
    "protein": number or null,
    "carbohydrates": number or null,
    "fat": number or null,
    "fiber": number or null,
    "sugar": number or null,
    "saturatedFat": number or null,
    "sodium": number or null
  },
  "servings": number or null,
  "confidence": 0.0-1.0
}

Examples:
Input: "Macros per serving: 350 cal, 25p, 30c, 12f"
Output: {"found": true, "perServing": {"calories": 350, "protein": 25, "carbohydrates": 30, "fat": 12}, "confidence": 0.95}

Input: "This tastes amazing!"
Output: {"found": false, "perServing": {}, "confidence": 0}`;
  }

  /**
   * Call AI API to extract nutrition
   */
  async callAI(prompt) {
    try {
      const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://fridgy.app',
          'X-Title': 'Fridgy Nutrition Extraction'
        },
        body: JSON.stringify({
          model: this.model,
          messages: [{
            role: 'user',
            content: prompt
          }],
          response_format: { type: 'json_object' },
          temperature: 0.1, // Very low temperature for precise extraction
          max_tokens: 500 // Small response
        })
      });

      if (!response.ok) {
        console.error('[NutritionExtractor] AI API error:', response.status);

        // Try fallback model
        if (this.fallbackModel) {
          console.log('[NutritionExtractor] Trying fallback model...');
          return await this.callAIWithFallback(prompt);
        }

        throw new Error(`AI API error: ${response.status}`);
      }

      const data = await response.json();
      const content = data.choices?.[0]?.message?.content;

      if (!content) {
        throw new Error('No response from AI');
      }

      // Parse JSON response
      const result = JSON.parse(content);

      return result;

    } catch (error) {
      console.error('[NutritionExtractor] AI call failed:', error.message);
      throw error;
    }
  }

  /**
   * Fallback to alternative model if primary fails
   */
  async callAIWithFallback(prompt) {
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://fridgy.app',
        'X-Title': 'Fridgy Nutrition Extraction'
      },
      body: JSON.stringify({
        model: this.fallbackModel,
        messages: [{
          role: 'user',
          content: prompt
        }],
        response_format: { type: 'json_object' },
        temperature: 0.1,
        max_tokens: 500
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
   * Format extracted nutrition data to match app's nutrition structure
   */
  formatNutritionData(extractedData, servings = 1) {
    const perServing = extractedData.perServing;

    return {
      perServing: {
        calories: perServing.calories ? {
          amount: Math.round(perServing.calories),
          unit: 'kcal',
          percentOfDailyNeeds: Math.round(perServing.calories / 2000 * 100)
        } : null,
        protein: perServing.protein ? {
          amount: Math.round(perServing.protein),
          unit: 'g',
          percentOfDailyNeeds: Math.round(perServing.protein / 50 * 100)
        } : null,
        carbohydrates: perServing.carbohydrates ? {
          amount: Math.round(perServing.carbohydrates),
          unit: 'g',
          percentOfDailyNeeds: Math.round(perServing.carbohydrates / 300 * 100)
        } : null,
        fat: perServing.fat ? {
          amount: Math.round(perServing.fat),
          unit: 'g',
          percentOfDailyNeeds: Math.round(perServing.fat / 65 * 100)
        } : null,
        saturatedFat: perServing.saturatedFat ? {
          amount: Math.round(perServing.saturatedFat),
          unit: 'g',
          percentOfDailyNeeds: Math.round(perServing.saturatedFat / 20 * 100)
        } : null,
        fiber: perServing.fiber ? {
          amount: Math.round(perServing.fiber),
          unit: 'g',
          percentOfDailyNeeds: Math.round(perServing.fiber / 25 * 100)
        } : null,
        sugar: perServing.sugar ? {
          amount: Math.round(perServing.sugar),
          unit: 'g',
          percentOfDailyNeeds: Math.round(perServing.sugar / 50 * 100)
        } : null,
        sodium: perServing.sodium ? {
          amount: Math.round(perServing.sodium),
          unit: 'mg',
          percentOfDailyNeeds: Math.round(perServing.sodium / 2300 * 100)
        } : null
      },
      caloricBreakdown: this.calculateCaloricBreakdown(perServing),
      isAIEstimated: false, // This is from the creator, not estimated
      source: 'creator',
      confidence: extractedData.confidence || 0.9,
      extractedFromCaption: true
    };
  }

  /**
   * Calculate caloric breakdown percentages
   */
  calculateCaloricBreakdown(nutrition) {
    const protein = nutrition.protein || 0;
    const carbs = nutrition.carbohydrates || 0;
    const fat = nutrition.fat || 0;

    const proteinCals = protein * 4;
    const carbsCals = carbs * 4;
    const fatCals = fat * 9;

    const totalCals = proteinCals + carbsCals + fatCals;

    if (totalCals === 0) {
      return {
        percentProtein: 0,
        percentCarbs: 0,
        percentFat: 0
      };
    }

    return {
      percentProtein: Math.round((proteinCals / totalCals) * 100),
      percentCarbs: Math.round((carbsCals / totalCals) * 100),
      percentFat: Math.round((fatCals / totalCals) * 100)
    };
  }
}

module.exports = NutritionExtractor;
