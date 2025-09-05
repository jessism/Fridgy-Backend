const fetch = require('node-fetch');

const mealAnalysisService = {
  /**
   * Analyze a meal image using AI to extract ingredients
   * @param {Buffer} imageBuffer - The image buffer
   * @returns {Promise<Array>} Array of detected ingredients
   */
  async analyzeMealImage(imageBuffer) {
    try {
      console.log('🍽️ Starting meal image analysis...');
      console.log('🍽️ Image buffer size:', imageBuffer.length, 'bytes');
      
      // Convert buffer to base64
      const base64Image = imageBuffer.toString('base64');
      const imageUrl = `data:image/jpeg;base64,${base64Image}`;
      console.log('🍽️ Base64 image created, length:', base64Image.length);

      // Prepare the AI prompt
      const prompt = `Analyze this meal photo and identify all consumed ingredients with standardized units.
      
      IMPORTANT UNIT STANDARDIZATION:
      - For proteins (meat, fish, tofu): ALWAYS use ounces (oz)
      - For vegetables: ALWAYS use ounces (oz) 
      - For grains/pasta (cooked): use cups
      - For liquids/sauces: use tablespoons (tbsp)
      - Never use "pieces" or "servings" - convert to weight/volume
      
      PORTION ESTIMATION GUIDE:
      - Typical chicken/meat serving: 4-6 oz
      - Typical fish serving: 4-5 oz
      - Typical vegetable serving: 4-8 oz
      - Typical rice/pasta (cooked): 1 cup (~6 oz)
      - Typical sauce/dressing: 2-4 tbsp
      
      Return ONLY a JSON object with this structure:
      {
        "meal_name": "concise name for the dish (2-4 words)",
        "ingredients": [
          {
            "name": "base ingredient name (e.g., 'chicken', 'broccoli')",
            "quantity": estimated amount consumed as number,
            "unit": "oz for proteins/vegetables, cups for grains, tbsp for sauces",
            "category": "protein/vegetable/grain/sauce/etc.",
            "calories": estimated calories (number),
            "confidence": confidence score 0-100
          }
        ]
      }
      
      Guidelines:
      - Use simple base ingredient names (chicken not "chicken breast, grilled")
      - Focus on what was CONSUMED (visible portion on plate)
      - Be conservative with portions if unsure
      - All proteins and vegetables MUST be in oz
      
      Example output:
      {
        "meal_name": "Grilled Chicken Dinner",
        "ingredients": [
          {"name": "chicken", "quantity": 5, "unit": "oz", "category": "protein", "calories": 220, "confidence": 90},
          {"name": "broccoli", "quantity": 6, "unit": "oz", "category": "vegetable", "calories": 50, "confidence": 85},
          {"name": "rice", "quantity": 1, "unit": "cup", "category": "grain", "calories": 200, "confidence": 80}
        ]
      }`;

      // Call OpenRouter API with Gemini
      console.log('🍽️ Calling OpenRouter API for meal analysis...');
      const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
          'HTTP-Referer': 'https://fridgy.app',
          'X-Title': 'Fridgy Meal Scanner'
        },
        body: JSON.stringify({
          model: 'google/gemini-2.0-flash-001',  // Use stable model like grocery scanner
          messages: [
            {
              role: 'user',
              content: [
                {
                  type: 'text',
                  text: prompt
                },
                {
                  type: 'image_url',
                  image_url: {
                    url: imageUrl
                  }
                }
              ]
            }
          ],
          temperature: 0.1,  // Lower temperature for more consistent results
          max_tokens: 1000
          // Removed response_format to match working grocery scanner
        })
      });

      console.log('🍽️ API Response status:', response.status);
      
      if (!response.ok) {
        const error = await response.text();
        console.error('❌ OpenRouter API error:', error);
        console.error('❌ Response status:', response.status);
        throw new Error(`Failed to analyze meal image: ${error}`);
      }

      const data = await response.json();
      console.log('🍽️ API Response received, choices:', data.choices?.length);
      
      // Extract the content from the response
      const content = data.choices?.[0]?.message?.content;
      console.log('🍽️ AI Response content:', content);
      
      if (!content) {
        console.error('❌ No content in AI response');
        throw new Error('No response from AI');
      }

      // Parse the JSON response
      let mealName = 'Home-cooked Meal';
      let ingredients;
      
      try {
        // Clean the response - remove any markdown code blocks
        const cleanContent = content
          .replace(/```json\n?/gi, '')
          .replace(/```\n?/gi, '')
          .trim();
        
        console.log('🍽️ Trying to parse cleaned content');
        const parsed = JSON.parse(cleanContent);
        
        // Check if response has the new format with meal_name
        if (parsed.meal_name && parsed.ingredients) {
          mealName = parsed.meal_name;
          ingredients = parsed.ingredients;
          console.log(`🍽️ Meal identified as: "${mealName}"`);
        } else if (Array.isArray(parsed)) {
          // Fallback for old format (just array of ingredients)
          ingredients = parsed;
          console.log('🍽️ Using legacy format (no meal name)');
        } else {
          // Try to extract from nested structure
          ingredients = parsed.ingredients || [];
        }
      } catch (parseError) {
        console.error('❌ Failed to parse AI response:', parseError.message);
        console.error('❌ Raw content:', content);
        
        // Fallback: try to extract JSON array pattern
        const jsonMatch = content.match(/\[[\s\S]*\]/);
        if (jsonMatch) {
          console.log('🍽️ Found JSON array pattern in response');
          ingredients = JSON.parse(jsonMatch[0]);
        } else {
          throw new Error('Invalid response format from AI');
        }
      }

      // Validate and clean up the ingredients
      const validatedIngredients = ingredients
        .filter(ing => ing.name && ing.quantity && ing.unit)
        .map(ing => ({
          name: ing.name.toLowerCase().trim(),
          quantity: parseFloat(ing.quantity) || 1,
          unit: ing.unit.toLowerCase().trim(),
          category: ing.category || 'other',
          calories: parseInt(ing.calories) || null,
          confidence: parseInt(ing.confidence) || 70
        }));

      console.log(`✅ Detected ${validatedIngredients.length} ingredients from meal image`);
      
      return {
        meal_name: mealName,
        ingredients: validatedIngredients
      };

    } catch (error) {
      console.error('❌ Meal analysis error:', error);
      throw error;
    }
  },

  /**
   * Match detected ingredients with user's inventory items
   * @param {Array} detectedIngredients - Ingredients from AI
   * @param {Array} inventoryItems - User's current inventory
   * @returns {Array} Matched ingredients with inventory IDs
   */
  matchWithInventory(detectedIngredients, inventoryItems) {
    const matches = [];

    for (const detected of detectedIngredients) {
      // Try to find exact match first
      let match = inventoryItems.find(item => 
        item.item_name.toLowerCase().includes(detected.name.toLowerCase()) ||
        detected.name.toLowerCase().includes(item.item_name.toLowerCase())
      );

      // If no exact match, try category match
      if (!match && detected.category) {
        match = inventoryItems.find(item => 
          item.category?.toLowerCase() === detected.category.toLowerCase() &&
          this.isSimilarFood(detected.name, item.item_name)
        );
      }

      if (match) {
        matches.push({
          ...detected,
          inventoryItemId: match.id,
          inventoryItemName: match.item_name,
          availableQuantity: match.quantity,
          expirationDate: match.expiration_date
        });
      } else {
        matches.push({
          ...detected,
          inventoryItemId: null,
          notInInventory: true
        });
      }
    }

    return matches;
  },

  /**
   * Check if two food names are similar
   */
  isSimilarFood(name1, name2) {
    const commonWords = ['chicken', 'beef', 'pork', 'rice', 'pasta', 'lettuce', 'tomato', 'onion', 'garlic'];
    
    const n1Lower = name1.toLowerCase();
    const n2Lower = name2.toLowerCase();
    
    return commonWords.some(word => 
      n1Lower.includes(word) && n2Lower.includes(word)
    );
  }
};

module.exports = mealAnalysisService;