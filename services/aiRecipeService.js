const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');

// Helper function to get Supabase client
const getSupabaseClient = () => {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_ANON_KEY;
  
  if (!supabaseUrl || !supabaseKey) {
    throw new Error('Supabase configuration missing');
  }
  
  return createClient(supabaseUrl, supabaseKey);
};

// AI Recipe Service using Gemini 2.0 Flash (reusing existing OpenRouter setup)
class AIRecipeService {
  constructor() {
    this.model = "google/gemini-2.0-flash-001";
    this.maxTokens = 2000; // Increased for detailed recipes
    this.temperature = 0.3; // Slightly higher for creativity
  }

  // Generate content hash for caching based on inventory + preferences + questionnaire + date
  generateContentHash(inventory, preferences, questionnaire = {}) {
    const today = new Date().toDateString();
    const sortedInventory = inventory
      .sort((a, b) => a.item_name.localeCompare(b.item_name))
      .map(item => ({
        name: item.item_name,
        quantity: item.quantity,
        expires: item.expiration_date,
        category: item.category
      }));
    
    const hashContent = {
      inventory: sortedInventory,
      preferences: {
        dietary_restrictions: preferences.dietary_restrictions?.sort() || [],
        allergies: preferences.allergies?.sort() || [],
        preferred_cuisines: preferences.preferred_cuisines?.sort() || [],
        cooking_time_preference: preferences.cooking_time_preference || ''
      },
      questionnaire: {
        meal_type: questionnaire.meal_type || '',
        cooking_time: questionnaire.cooking_time || '',
        vibe: questionnaire.vibe || '',
        cuisine_preference: questionnaire.cuisine_preference || '',
        dietary_considerations: questionnaire.dietary_considerations?.sort() || [],
        additional_notes: questionnaire.additional_notes || ''
      },
      date: today
    };

    return crypto
      .createHash('sha256')
      .update(JSON.stringify(hashContent))
      .digest('hex')
      .substring(0, 16); // Use first 16 chars for shorter hash
  }

  // Check if we have cached recipes for this content hash
  async getCachedRecipes(userId, contentHash) {
    const requestId = Math.random().toString(36).substring(7);
    
    try {
      console.log(`🍽️  [${requestId}] Checking cache for user ${userId}, hash: ${contentHash}`);
      
      const supabase = getSupabaseClient();
      const { data, error } = await supabase
        .from('ai_generated_recipes')
        .select('*')
        .eq('user_id', userId)
        .eq('content_hash', contentHash)
        .gt('expires_at', new Date().toISOString())
        .single();

      if (error && error.code !== 'PGRST116') {
        console.log(`⚠️  [${requestId}] Cache check error (non-critical):`, error.message);
        return null;
      }

      if (data) {
        console.log(`✅ [${requestId}] Cache hit! Found recipes created at ${data.created_at}`);
        
        // Update last_accessed timestamp
        await supabase
          .from('ai_generated_recipes')
          .update({ last_accessed: new Date().toISOString() })
          .eq('id', data.id);
        
        return data;
      }

      console.log(`🚫 [${requestId}] No cached recipes found`);
      return null;

    } catch (error) {
      console.error(`❌ [${requestId}] Cache check failed:`, error);
      return null; // Don't fail generation if cache check fails
    }
  }

  // Generate recipes using Gemini 2.0 Flash (adapted from existing food analysis)
  async generateRecipes(inventory, preferences, questionnaire = {}) {
    const requestId = Math.random().toString(36).substring(7);
    
    try {
      console.log(`\n🤖 =============== AI RECIPE GENERATION START ===============`);
      console.log(`🤖 REQUEST ID: ${requestId}`);
      console.log(`🤖 Using Gemini 2.0 Flash for recipe generation`);
      console.log(`🤖 Inventory items: ${inventory.length}`);
      console.log(`🤖 Timestamp: ${new Date().toISOString()}`);
      console.log(`🤖 =======================================================\n`);
      
      // Step 1: Validate API key (reusing existing validation)
      console.log(`🔐 [${requestId}] Step 1: Validating OpenRouter API key...`);
      if (!process.env.OPENROUTER_API_KEY) {
        throw new Error('OPENROUTER_API_KEY is missing from environment variables');
      }
      
      const apiKey = process.env.OPENROUTER_API_KEY;
      console.log(`🔐 [${requestId}] API key validated successfully`);

      // Step 2: Build comprehensive recipe prompt
      console.log(`📝 [${requestId}] Step 2: Building recipe generation prompt...`);
      
      const inventoryText = inventory.map(item => 
        `- ${item.item_name} (Qty: ${item.quantity}, Expires: ${item.expiration_date}, Category: ${item.category})`
      ).join('\n');

      const restrictionsText = preferences.dietary_restrictions?.length ? 
        preferences.dietary_restrictions.join(', ') : 'None';
      const allergiesText = preferences.allergies?.length ? 
        preferences.allergies.join(', ') : 'None';
      const cuisinePrefsText = preferences.preferred_cuisines?.length ? 
        preferences.preferred_cuisines.join(', ') : 'Any cuisine';
      const timePreferenceText = preferences.cooking_time_preference || 'Any cooking time';

      // Build questionnaire context
      const mealTypeText = this.getMealTypeDescription(questionnaire.meal_type);
      const cookingTimeText = this.getCookingTimeDescription(questionnaire.cooking_time);
      const vibeText = this.getVibeDescription(questionnaire.vibe);
      const cuisinePreferenceText = this.getCuisineDescription(questionnaire.cuisine_preference);
      const dietaryConsiderationsText = questionnaire.dietary_considerations?.length ? 
        questionnaire.dietary_considerations.join(', ') : 'None';
      const additionalNotesText = questionnaire.additional_notes || 'None';
      const servingSizeText = questionnaire.serving_size || 2; // Default to 2 if not provided

      const recipePrompt = `You are a professional chef and recipe developer. Analyze the user's current fridge inventory and specific preferences to create exactly 3 unique, delicious recipes using ONLY the available ingredients.

CURRENT FRIDGE INVENTORY:
${inventoryText}

USER DIETARY PREFERENCES:
- Dietary Restrictions: ${restrictionsText}
- Allergies: ${allergiesText}  
- Preferred Cuisines: ${cuisinePrefsText}
- Cooking Time Preference: ${timePreferenceText}
- Custom Allergies: ${preferences.custom_allergies || 'None'}

CURRENT COOKING CONTEXT:
- Meal Type: ${mealTypeText}
- Target Serving Size: ${servingSizeText} ${servingSizeText === 1 ? 'serving' : 'servings'}
- Available Cooking Time: ${cookingTimeText}
- Desired Vibe: ${vibeText}
- Cuisine Preference: ${cuisinePreferenceText}
- Special Considerations: ${dietaryConsiderationsText}
- Additional Notes: ${additionalNotesText}

STRICT REQUIREMENTS:
1. Use ONLY ingredients from the inventory above - no additional ingredients
2. Respect ALL dietary restrictions and allergies completely
3. Create 3 completely different recipes with different cooking methods
4. MUST match the specified meal type and cooking time constraints
5. MUST reflect the desired vibe and cuisine preference
6. Consider expiration dates - use items expiring sooner first
7. Scale ingredient amounts appropriately for the requested serving size (${servingSizeText} servings)
8. Ensure portion sizes are realistic and practical for the target serving count
9. Incorporate any additional notes and special considerations
10. Each recipe should be practical, delicious, and contextually appropriate

SERVING SIZE SCALING INSTRUCTIONS:
- Target serving size: ${servingSizeText} ${servingSizeText === 1 ? 'serving' : 'servings'}
- Scale ALL ingredient amounts proportionally to serve exactly ${servingSizeText} ${servingSizeText === 1 ? 'person' : 'people'}
- Ensure measurements are practical (e.g., don't call for "0.3 eggs" - round sensibly to "1 egg")
- Instructions should reflect the scaled quantities and cooking times may need adjustment
- Consider cookware size - larger servings may need bigger pans or longer cooking times

Return ONLY a valid JSON array with exactly 2 recipes in this format:
[
  {
    "title": "Descriptive Recipe Name",
    "description": "Brief appetizing 1-sentence description",
    "prep_time": "X minutes",
    "cook_time": "X minutes", 
    "total_time": "X minutes",
    "servings": ${servingSizeText},
    "difficulty": "Easy|Medium|Hard",
    "cuisine_type": "Italian|Asian|American|etc",
    "ingredients": [
      {"item": "exact ingredient name from inventory", "amount": "1 cup", "from_inventory": true}
    ],
    "instructions": [
      "Step 1: Clear, detailed instruction",
      "Step 2: Next step with specific details",
      "Step 3: Continue until complete"
    ],
    "key_ingredients": ["main", "visible", "ingredients", "for", "photo"],
    "dietary_info": {
      "vegetarian": true,
      "vegan": false,
      "gluten_free": true,
      "dairy_free": false
    },
    "tips": "One helpful cooking tip for best results"
  }
]

Focus on creating restaurant-quality recipes that showcase the available ingredients beautifully.`;

      // Step 3: Prepare request body (using existing pattern)
      console.log(`⚙️  [${requestId}] Step 3: Preparing request body...`);
      const messages = [
        {
          role: "user",
          content: recipePrompt
        }
      ];

      const requestBody = {
        model: this.model,
        messages: messages,
        max_tokens: this.maxTokens,
        temperature: this.temperature
      };
      
      console.log(`⚙️  [${requestId}] Request prepared - Model: ${this.model}, Max tokens: ${this.maxTokens}`);

      // Step 4: Make API request (reusing existing pattern)
      console.log(`🌐 [${requestId}] Step 4: Making OpenRouter API request...`);
      const fetchStartTime = Date.now();
      
      const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://fridgy-app.com',
          'X-Title': 'Fridgy - AI Recipe Generation'
        },
        body: JSON.stringify(requestBody)
      });
      
      const fetchDuration = Date.now() - fetchStartTime;
      console.log(`🌐 [${requestId}] API request completed in ${fetchDuration}ms`);
      console.log(`🌐 [${requestId}] Response status: ${response.status} ${response.statusText}`);

      if (!response.ok) {
        const errorText = await response.text();
        console.error(`❌ [${requestId}] OpenRouter API error: ${response.status} - ${errorText}`);
        throw new Error(`OpenRouter API error: ${response.status} ${response.statusText} - ${errorText}`);
      }

      // Step 5: Parse and validate response
      console.log(`📥 [${requestId}] Step 5: Parsing recipe response...`);
      const completion = await response.json();
      
      if (!completion.choices || completion.choices.length === 0) {
        throw new Error('No choices returned from OpenRouter API');
      }
      
      const recipeText = completion.choices[0].message.content;
      console.log(`📥 [${requestId}] Raw recipe response length: ${recipeText.length} characters`);
      
      // Parse JSON response with fallback
      let recipes;
      try {
        recipes = JSON.parse(recipeText);
        console.log(`✅ [${requestId}] JSON parsing successful - ${recipes.length} recipes generated`);
      } catch (parseError) {
        console.log(`🔄 [${requestId}] Primary JSON parsing failed, attempting fallback...`);
        // Try to extract JSON array from response
        const jsonMatch = recipeText.match(/\[[\s\S]*\]/);
        if (jsonMatch) {
          recipes = JSON.parse(jsonMatch[0]);
          console.log(`✅ [${requestId}] Fallback parsing successful - ${recipes.length} recipes extracted`);
        } else {
          console.error(`❌ [${requestId}] Could not parse recipe response:`, recipeText.substring(0, 500));
          throw new Error('Failed to parse recipe JSON response');
        }
      }

      // Validate recipes structure
      if (!Array.isArray(recipes) || recipes.length !== 2) {
        console.error(`❌ [${requestId}] Invalid recipe structure - expected 2 recipes, got:`, recipes.length);
        throw new Error(`Expected exactly 2 recipes, got ${recipes.length}`);
      }

      console.log(`🎉 [${requestId}] Recipe generation successful!`);
      recipes.forEach((recipe, index) => {
        console.log(`🍽️  [${requestId}] Recipe ${index + 1}: "${recipe.title}" (${recipe.cuisine_type}, ${recipe.difficulty})`);
      });

      console.log(`\n✅ [${requestId}] =============== RECIPE GENERATION COMPLETE ===============\n`);
      return recipes;

    } catch (error) {
      console.error(`\n💥 [${requestId}] ========== RECIPE GENERATION ERROR ==========`);
      console.error(`💥 [${requestId}] Error:`, error.message);
      console.error(`💥 [${requestId}] Stack:`, error.stack);
      console.error(`💥 [${requestId}] ===========================================\n`);
      throw error;
    }
  }

  // Save generated recipes to cache
  async cacheRecipes(userId, contentHash, recipes, imageUrls = [], questionnaire = {}) {
    const requestId = Math.random().toString(36).substring(7);
    
    try {
      console.log(`💾 [${requestId}] Caching recipes for user ${userId}...`);
      
      const supabase = getSupabaseClient();
      const expiresAt = new Date();
      expiresAt.setHours(expiresAt.getHours() + 24); // 24-hour cache
      
      const { data, error } = await supabase
        .from('ai_generated_recipes')
        .upsert({
          user_id: userId,
          content_hash: contentHash,
          recipes: recipes,
          image_urls: imageUrls,
          questionnaire_data: questionnaire,
          generation_status: imageUrls.length > 0 ? 'completed' : 'pending',
          expires_at: expiresAt.toISOString(),
          last_accessed: new Date().toISOString()
        }, {
          onConflict: 'content_hash'
        })
        .select('*')
        .single();

      if (error) {
        console.error(`❌ [${requestId}] Failed to cache recipes:`, error);
        throw error;
      }

      console.log(`✅ [${requestId}] Recipes cached successfully with ID: ${data.id}`);
      return data;

    } catch (error) {
      console.error(`❌ [${requestId}] Cache save failed:`, error);
      throw error;
    }
  }

  // Main method to get recipes (with caching)
  async getRecipesForUser(userId, inventory, preferences, questionnaire = {}) {
    const requestId = Math.random().toString(36).substring(7);
    const startTime = Date.now();
    
    try {
      console.log(`\n🎬 [${requestId}] Starting recipe generation for user ${userId}...`);
      console.log(`🎬 [${requestId}] Questionnaire data:`, Object.keys(questionnaire).length > 0 ? questionnaire : 'None');
      
      // Generate content hash including questionnaire data
      const contentHash = this.generateContentHash(inventory, preferences, questionnaire);
      console.log(`🔑 [${requestId}] Content hash: ${contentHash}`);
      
      // Check cache first
      const cachedRecipes = await this.getCachedRecipes(userId, contentHash);
      if (cachedRecipes) {
        const duration = Date.now() - startTime;
        console.log(`⚡ [${requestId}] Returning cached recipes in ${duration}ms`);
        
        // Log cache hit for analytics
        await this.logAnalytics(userId, duration, 2, true, 0);
        
        return {
          recipes: cachedRecipes.recipes,
          imageUrls: cachedRecipes.image_urls,
          cached: true,
          generatedAt: cachedRecipes.created_at
        };
      }

      // Generate new recipes with questionnaire data
      console.log(`🚀 [${requestId}] No cache found, generating new recipes...`);
      const recipes = await this.generateRecipes(inventory, preferences, questionnaire);
      
      // Cache the recipes (without images initially) 
      const cachedData = await this.cacheRecipes(userId, contentHash, recipes, [], questionnaire);
      
      const duration = Date.now() - startTime;
      console.log(`🎉 [${requestId}] Recipe generation complete in ${duration}ms`);
      
      // Log generation analytics  
      await this.logAnalytics(userId, duration, 2, false, 0.0002); // Estimated Gemini cost
      
      return {
        recipes: recipes,
        imageUrls: [],
        cached: false,
        generatedAt: cachedData.created_at,
        cacheId: cachedData.id
      };

    } catch (error) {
      const duration = Date.now() - startTime;
      console.error(`💥 [${requestId}] Recipe generation failed after ${duration}ms:`, error);
      
      // Log error for analytics
      await this.logAnalytics(userId, duration, 0, false, 0, error.message.substring(0, 50));
      
      throw error;
    }
  }

  // Log analytics for optimization and cost tracking
  async logAnalytics(userId, generationTime, recipeCount, cacheHit, cost, errorType = null) {
    try {
      const supabase = getSupabaseClient();
      await supabase
        .from('ai_recipe_analytics')
        .insert({
          user_id: userId,
          generation_time_ms: generationTime,
          recipe_count: recipeCount,
          cache_hit: cacheHit,
          total_cost: cost,
          error_type: errorType
        });
    } catch (error) {
      console.log('Analytics logging failed (non-critical):', error.message);
    }
  }

  // Utility method to clean up expired caches (can be called periodically)
  async cleanupExpiredCache() {
    try {
      const supabase = getSupabaseClient();
      const { data, error } = await supabase
        .from('ai_generated_recipes')
        .delete()
        .lt('expires_at', new Date().toISOString());
      
      if (!error && data) {
        console.log(`🧹 Cleaned up ${data.length} expired recipe caches`);
      }
    } catch (error) {
      console.log('Cache cleanup failed (non-critical):', error.message);
    }
  }

  // Helper methods for questionnaire descriptions
  getMealTypeDescription(mealType) {
    const descriptions = {
      'breakfast': 'Breakfast recipes suitable for morning meals',
      'lunch': 'Lunch recipes perfect for midday meals', 
      'dinner': 'Dinner recipes ideal for evening meals',
      'snack': 'Light snack recipes for between meals'
    };
    return descriptions[mealType] || 'Any meal type';
  }

  getCookingTimeDescription(cookingTime) {
    const descriptions = {
      '15_minutes': '15 minutes or less - quick and simple',
      '30_minutes': '30 minutes - moderate prep and cooking',
      '45_minutes': '45 minutes - more involved cooking',
      '60_minutes': '1 hour - elaborate recipes with multiple steps',
      '90_plus_minutes': '90+ minutes - complex, slow-cooked meals'
    };
    return descriptions[cookingTime] || 'Any cooking time';
  }

  getVibeDescription(vibe) {
    const descriptions = {
      'healthy': 'Healthy, nutritious recipes with fresh ingredients',
      'light': 'Light, refreshing recipes that won\'t weigh you down',
      'comfort_food': 'Comforting, hearty recipes that satisfy cravings',
      'quick_easy': 'Quick and easy recipes with minimal prep',
      'fancy': 'Fancy, restaurant-style recipes for special occasions'
    };
    return descriptions[vibe] || 'Any cooking style';
  }

  getCuisineDescription(cuisine) {
    const descriptions = {
      'any': 'Any cuisine style',
      'italian': 'Italian cuisine with Mediterranean flavors',
      'asian': 'Asian cuisine with bold, aromatic flavors',
      'mexican': 'Mexican cuisine with spices and fresh ingredients',
      'american': 'American comfort food and classic dishes',
      'mediterranean': 'Mediterranean cuisine with olive oil and fresh herbs'
    };
    return descriptions[cuisine] || 'Any cuisine style';
  }
}

module.exports = new AIRecipeService();