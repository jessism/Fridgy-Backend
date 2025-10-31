const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');
const NutritionAnalysisService = require('./nutritionAnalysisService');
const nutritionAnalysisService = new NutritionAnalysisService();

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
        ingredient_usage_preference: questionnaire.ingredient_usage_preference || 'use_most',
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
  async generateRecipes(inventory, preferences, questionnaire = {}, retryAttempt = 0) {
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
      const ingredientUsagePreference = questionnaire.ingredient_usage_preference || 'use_most';

      // Group inventory by category for clearer understanding
      const proteins = inventory.filter(i => i.category === 'Protein' || i.category === 'Meat').map(i => i.item_name);
      const vegetables = inventory.filter(i => i.category === 'Vegetables').map(i => i.item_name);
      const fruits = inventory.filter(i => i.category === 'Fruits').map(i => i.item_name);
      const dairy = inventory.filter(i => i.category === 'Dairy').map(i => i.item_name);
      const grains = inventory.filter(i => i.category === 'Grains' || i.category === 'Pasta').map(i => i.item_name);

      // Make prompt stronger on retries
      const retryWarning = retryAttempt > 0 ? `
⚠️⚠️⚠️ CRITICAL WARNING - ATTEMPT ${retryAttempt + 1} ⚠️⚠️⚠️
Your previous recipes were REJECTED for using ingredients NOT in the inventory.
This is your ${retryAttempt === 1 ? 'SECOND' : 'FINAL'} attempt.
YOU MUST ONLY USE THE EXACT INGREDIENTS LISTED BELOW.
DO NOT SUGGEST: chicken, beef, pork, tilapia, cod, turkey, lamb, or ANY protein not listed.
⚠️⚠️⚠️ FAILURE TO COMPLY WILL RESULT IN REJECTION ⚠️⚠️⚠️

` : '';

      const recipePrompt = `${retryWarning}You are an expert chef creating personalized recipes for a home cook. You MUST follow these rules in STRICT PRIORITY ORDER.

🔴 CRITICAL CONSTRAINTS - VIOLATION WILL CAUSE REJECTION:

1. MAIN INGREDIENTS - You can ONLY use these items from the user's fridge:
${inventoryText}

   Available Proteins: ${proteins.length > 0 ? proteins.join(', ') : 'NONE'}
   Available Vegetables: ${vegetables.length > 0 ? vegetables.join(', ') : 'NONE'}
   Available Fruits: ${fruits.length > 0 ? fruits.join(', ') : 'NONE'}
   Available Dairy: ${dairy.length > 0 ? dairy.join(', ') : 'NONE'}
   
   ⚠️ CRITICAL: You can ONLY use the proteins listed above. If no proteins listed, make vegetarian.
   ⚠️ CRITICAL: FORBIDDEN - Do NOT suggest ANY of these if not in the list: chicken, beef, pork, tilapia, cod, turkey, lamb, fish, seafood
   ⚠️ CRITICAL: Every main ingredient MUST be from the inventory list above. NO EXCEPTIONS.

2. ALLERGIES & RESTRICTIONS - NEVER VIOLATE:
   ${allergiesText !== 'None' ? `❌ NEVER USE: ${allergiesText} - User is ALLERGIC!` : ''}
   ${restrictionsText !== 'None' ? `❌ MUST RESPECT: ${restrictionsText}` : ''}
   ${preferences.custom_allergies ? `❌ ALSO AVOID: ${preferences.custom_allergies}` : ''}

🟡 MANDATORY PREFERENCES - MUST FOLLOW:

3. CURRENT MEAL REQUEST:
   - MUST BE: ${mealTypeText}
   - MUST COMPLETE IN: ${cookingTimeText}
   - MUST MATCH VIBE: ${vibeText}
   - MUST SERVE: Exactly ${servingSizeText} ${servingSizeText === 1 ? 'person' : 'people'}
   ${questionnaire.additional_notes ? `- SPECIAL REQUEST: ${additionalNotesText}` : ''}

4. USER PROFILE PREFERENCES:
   - Preferred Cuisines: ${cuisinePrefsText}
   - Skill Level: ${timePreferenceText}
   ${dietaryConsiderationsText !== 'None' ? `- Today's Considerations: ${dietaryConsiderationsText}` : ''}

${this.getIngredientUsageSection(ingredientUsagePreference)}

VALIDATION BEFORE RETURNING:
□ Each recipe uses at least 2-3 MAIN ingredients from the fridge inventory
□ NO allergic ingredients included anywhere
□ All 3 recipes are ${questionnaire.meal_type || 'appropriate'} meals
□ All can be completed within ${cookingTimeText}
□ All match the ${vibeText} style requested
□ All serve exactly ${servingSizeText} people

THINK STEP BY STEP:
1. What proteins do I have? ${proteins.length > 0 ? proteins.join(', ') : 'NO PROTEINS - make vegetarian'}
2. What vegetables? ${vegetables.length > 0 ? vegetables.join(', ') : 'None available'}
3. Can I make ${questionnaire.meal_type} with these? YES - proceed
4. Will it be ${vibeText}? Make sure it matches

BEFORE RETURNING YOUR ANSWER:
- Review each recipe's main ingredients
- Confirm EVERY protein/meat is from: ${proteins.length > 0 ? proteins.join(', ') : 'NONE (vegetarian only)'}
- If you included chicken/beef/pork/tilapia/fish and they're NOT in the list above, DELETE that recipe and create a new one

Return ONLY a valid JSON array with exactly 3 recipes in this format:
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
      if (!Array.isArray(recipes) || recipes.length !== 3) {
        console.error(`❌ [${requestId}] Invalid recipe structure - expected 3 recipes, got:`, recipes.length);
        throw new Error(`Expected exactly 3 recipes, got ${recipes.length}`);
      }

      // Post-generation validation: Ensure recipes use inventory items
      console.log(`🔍 [${requestId}] Validating recipes against inventory...`);
      const validationIssues = [];
      
      recipes.forEach((recipe, index) => {
        console.log(`🔍 [${requestId}] Validating Recipe ${index + 1}: "${recipe.title}"`);
        
        // Check if recipe uses any main ingredients from inventory
        const recipeIngredients = recipe.ingredients.map(ing => ing.item.toLowerCase());
        const inventoryNames = inventory.map(item => item.item_name.toLowerCase());
        
        // Check for main ingredient usage (excluding pantry staples)
        const pantryStaples = ['salt', 'pepper', 'oil', 'butter', 'flour', 'sugar', 'garlic powder', 
                              'onion powder', 'milk', 'cream', 'water', 'vinegar', 'soy sauce'];
        
        const mainIngredientsUsed = recipeIngredients.filter(ing => {
          // Check if this is a pantry staple
          const isPantryStaple = pantryStaples.some(staple => ing.includes(staple));
          if (isPantryStaple) return false;
          
          // Check if this ingredient is from inventory
          return inventoryNames.some(invItem => 
            ing.includes(invItem) || invItem.includes(ing)
          );
        });
        
        if (mainIngredientsUsed.length === 0) {
          validationIssues.push(`Recipe "${recipe.title}" uses NO items from inventory!`);
          console.error(`❌ [${requestId}] Recipe ${index + 1} validation failed: No inventory items used`);
        } else {
          console.log(`✅ [${requestId}] Recipe ${index + 1} uses inventory items: ${mainIngredientsUsed.join(', ')}`);
        }
        
        // Check for forbidden ingredients (proteins not in inventory)
        const forbiddenProteins = [
          'chicken', 'beef', 'pork', 'tilapia', 'cod', 'turkey', 'lamb',
          'salmon', 'tuna', 'shrimp', 'crab', 'lobster', 'fish', 'steak',
          'bacon', 'sausage', 'ham', 'duck', 'venison', 'veal', 'goat',
          'prawns', 'scallops', 'mussels', 'clams', 'oysters', 'squid',
          'halibut', 'trout', 'bass', 'mahi', 'snapper', 'grouper'
        ];
        const availableProteins = inventory
          .filter(item => item.category === 'Protein' || item.category === 'Meat')
          .map(item => item.item_name.toLowerCase());
        
        forbiddenProteins.forEach(protein => {
          if (recipeIngredients.some(ing => ing.includes(protein)) && 
              !availableProteins.some(avail => avail.includes(protein))) {
            validationIssues.push(`Recipe "${recipe.title}" uses ${protein} which is NOT in inventory!`);
            console.error(`❌ [${requestId}] Forbidden protein detected: ${protein}`);
          }
        });
      });
      
      if (validationIssues.length > 0) {
        console.error(`❌ [${requestId}] Recipe validation failed with ${validationIssues.length} issues:`);
        validationIssues.forEach(issue => console.error(`   - ${issue}`));

        // Throw error to trigger retry
        const errorMsg = `Recipe validation failed (attempt ${retryAttempt + 1}): ${validationIssues.join('; ')}`;
        console.error(`❌ [${requestId}] ${errorMsg}`);
        throw new Error(errorMsg);
      } else {
        console.log(`✅ [${requestId}] All recipes validated successfully!`);
      }

      // ========== CHECKPOINT: ABOUT TO START NUTRITION ENRICHMENT ==========
      console.log(`\n🔬🔬🔬 [${requestId}] ========== CHECKPOINT: STARTING NUTRITION ENRICHMENT ==========`);
      console.log(`🔬 [${requestId}] Number of recipes to enrich: ${recipes.length}`);
      console.log(`🔬 [${requestId}] First recipe title: ${recipes[0]?.title}`);
      console.log(`🔬 [${requestId}] First recipe has ${recipes[0]?.ingredients?.length || 0} ingredients`);
      console.log(`🔬🔬🔬 [${requestId}] ================================================================\n`);

      // Step: Enrich recipes with nutrition data using dedicated service
      console.log(`🍎 [${requestId}] Enriching recipes with nutrition data...`);
      for (let i = 0; i < recipes.length; i++) {
        const recipe = recipes[i];
        try {
          console.log(`🍎 [${requestId}] Analyzing nutrition for Recipe ${i + 1}: "${recipe.title}"...`);

          // Transform AI recipe format to nutrition service format
          // AI recipes have {item: "chicken", amount: "1 cup", from_inventory: true}
          // Service expects: {name: "chicken", amount: "1", unit: "cup", original: "1 cup chicken"}
          const recipeForNutrition = {
            title: recipe.title,
            servings: recipe.servings || 2,
            extendedIngredients: recipe.ingredients?.map(ing => ({
              name: ing.item || ing.name || '',
              original: `${ing.amount || ''} ${ing.item || ''}`.trim(),
              amount: ing.amount || '',
              unit: '',
              // Add measures format for compatibility
              measures: {
                us: {
                  amount: ing.amount || '',
                  unitShort: ''
                }
              }
            })) || [],
            instructions: recipe.instructions || []
          };

          console.log(`🍎 [${requestId}] Recipe for nutrition has ${recipeForNutrition.extendedIngredients.length} ingredients`);

          // Use the same nutrition service that imported recipes use
          const nutrition = await nutritionAnalysisService.analyzeRecipeNutrition(recipeForNutrition);

          if (nutrition) {
            recipes[i].nutrition = nutrition;
            console.log(`✅ [${requestId}] Recipe ${i + 1} nutrition added: ${nutrition.perServing?.calories?.amount || 'N/A'} calories`);
          } else {
            console.warn(`⚠️  [${requestId}] Recipe ${i + 1} nutrition analysis returned null - using zero fallback`);
            // Provide default nutrition structure instead of null
            recipes[i].nutrition = {
              perServing: {
                calories: { amount: 0, unit: 'kcal', percentOfDailyNeeds: 0 },
                protein: { amount: 0, unit: 'g', percentOfDailyNeeds: 0 },
                carbohydrates: { amount: 0, unit: 'g', percentOfDailyNeeds: 0 },
                fat: { amount: 0, unit: 'g', percentOfDailyNeeds: 0 },
                fiber: { amount: 0, unit: 'g', percentOfDailyNeeds: 0 },
                sugar: { amount: 0, unit: 'g', percentOfDailyNeeds: 0 },
                sodium: { amount: 0, unit: 'mg', percentOfDailyNeeds: 0 }
              },
              caloricBreakdown: { percentProtein: 0, percentFat: 0, percentCarbs: 0 },
              isAIEstimated: false,
              confidence: 0,
              estimationNotes: 'Nutrition data unavailable'
            };
          }
        } catch (error) {
          console.error(`❌ [${requestId}] Failed to analyze nutrition for Recipe ${i + 1} ("${recipe.title}"): ${error.message}`);
          // Provide default nutrition structure instead of null
          recipes[i].nutrition = {
            perServing: {
              calories: { amount: 0, unit: 'kcal', percentOfDailyNeeds: 0 },
              protein: { amount: 0, unit: 'g', percentOfDailyNeeds: 0 },
              carbohydrates: { amount: 0, unit: 'g', percentOfDailyNeeds: 0 },
              fat: { amount: 0, unit: 'g', percentOfDailyNeeds: 0 },
              fiber: { amount: 0, unit: 'g', percentOfDailyNeeds: 0 },
              sugar: { amount: 0, unit: 'g', percentOfDailyNeeds: 0 },
              sodium: { amount: 0, unit: 'mg', percentOfDailyNeeds: 0 }
            },
            caloricBreakdown: { percentProtein: 0, percentFat: 0, percentCarbs: 0 },
            isAIEstimated: false,
            confidence: 0,
            estimationNotes: 'Error calculating nutrition'
          };
        }
      }
      console.log(`✅ [${requestId}] Nutrition enrichment complete!`);

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

      // Generate new recipes with questionnaire data and retry logic
      console.log(`🚀 [${requestId}] No cache found, generating new recipes...`);

      let recipes = null;
      const maxRetries = 3;
      let lastError = null;

      for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
          console.log(`🔄 [${requestId}] Generation attempt ${attempt + 1} of ${maxRetries}...`);
          recipes = await this.generateRecipes(inventory, preferences, questionnaire, attempt);
          console.log(`✅ [${requestId}] Recipe generation successful on attempt ${attempt + 1}`);
          break; // Success, exit retry loop
        } catch (error) {
          lastError = error;
          console.error(`❌ [${requestId}] Attempt ${attempt + 1} failed: ${error.message}`);

          if (attempt === maxRetries - 1) {
            console.error(`💥 [${requestId}] All ${maxRetries} attempts failed. Giving up.`);
            throw new Error(`Recipe generation failed after ${maxRetries} attempts. The AI is not respecting inventory constraints. Last error: ${lastError.message}`);
          } else {
            console.log(`🔄 [${requestId}] Retrying with stronger constraints...`);
            // Small delay before retry
            await new Promise(resolve => setTimeout(resolve, 1000));
          }
        }
      }

      if (!recipes) {
        throw new Error('Recipe generation failed - no recipes generated');
      }

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

  getIngredientUsageSection(preference) {
    const sections = {
      'only_inventory': `🟢 PANTRY STAPLES - You MAY assume these are available:
   - Basic seasonings: salt, pepper, sugar
   - Oils/fats: butter, olive oil, vegetable oil, cooking spray
   - Water

🔴🔴🔴 CRITICAL - USER SELECTED "ONLY MY LOGGED INGREDIENTS" MODE:
   ❌ DO NOT assume eggs, milk, cream, flour, or ANY other ingredients
   ❌ DO NOT assume bread, rice, pasta, noodles, or any starches
   ❌ DO NOT assume garlic, onions, ginger, or any fresh produce (unless logged)
   ❌ DO NOT assume soy sauce, vinegar, lemon juice, or any condiments
   ❌ DO NOT assume garlic powder, onion powder, or any spices beyond salt & pepper
   ❌ DO NOT assume broth, stock, or bouillon
   ❌ DO NOT assume breadcrumbs, cornstarch, or baking ingredients

   ✅ ONLY USE: Items explicitly in their inventory + salt/pepper/sugar/butter/oil/water

   ⚠️ USER CHOSE STRICT MODE - THEY WANT RECIPES WITH EXACTLY WHAT THEY LOGGED
   ⚠️ If eggs needed, they MUST be in the inventory list above
   ⚠️ If recipe needs something not logged, CREATE A DIFFERENT RECIPE`,

      'use_most': `🟢 PANTRY STAPLES - You MAY assume these are available:
   - Basic seasonings: salt, pepper, sugar, garlic powder, onion powder, paprika
   - Oils/fats: olive oil, vegetable oil, butter, cooking spray
   - Common liquids: water, milk, cream
   - Basic items: flour, eggs
   - Common condiments: soy sauce, vinegar, lemon juice, mustard
   - Dried herbs: oregano, basil, thyme, parsley

🟡 MODERATE MODE - USER SELECTED "USE MOST LOGGED INGREDIENTS":
   ✅ You can use the pantry staples above even if not logged
   ✅ Recipes should feature 3-4+ items from their logged inventory
   ❌ DO NOT assume bread, rice, pasta, or major starches (unless logged)
   ❌ DO NOT assume ANY proteins not in their logged inventory
   ❌ DO NOT assume fresh produce like onions, garlic, ginger (unless logged)
   ❌ DO NOT assume specialty cheeses or ingredients

   📌 Their logged ingredients should be the STARS of the recipe
   📌 Pantry staples are supporting roles only`,

      'fully_flexible': `🟢 PANTRY STAPLES - You MAY assume these are available:
   - Basic seasonings: salt, pepper, garlic powder, onion powder, paprika, cumin, etc.
   - Oils/fats: olive oil, vegetable oil, butter, cooking spray
   - Common liquids: water, milk, cream, broth, stock
   - Basic items: flour, sugar, eggs, breadcrumbs
   - Common acids: vinegar, lemon juice, soy sauce, lime juice
   - Dried herbs: oregano, basil, thyme, paprika, parsley
   - Common starches: You can suggest bread, rice, pasta if needed for recipe

🟢 CREATIVE MODE - USER SELECTED "SUGGEST ANY INGREDIENTS":
   ✅ You have freedom to suggest additional ingredients for great recipes
   ✅ Can suggest proteins, vegetables, starches to complement their inventory
   ✅ Try to incorporate 2-3+ items from their logged inventory when possible
   ✅ Mark suggested additions with "from_inventory": false

   🎨 Focus on creating delicious, inspiring recipes that showcase possibilities`
    };

    return sections[preference] || sections['use_most'];
  }
}

module.exports = new AIRecipeService();