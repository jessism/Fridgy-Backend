// Load environment variables FIRST before any other imports
const dotenv = require('dotenv');
dotenv.config();

const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const OpenAI = require('openai');
const multer = require('multer');

// Import middleware
const authMiddleware = require('./middleware/auth');

// Import routes
const authRoutes = require('./routes/auth');
const inventoryRoutes = require('./routes/inventory');
const inventoryAnalyticsRoutes = require('./routes/inventoryAnalytics');
const recipeRoutes = require('./routes/recipes');
const userPreferencesRoutes = require('./routes/userPreferences');
const aiRecipeRoutes = require('./routes/aiRecipes');
const mealRoutes = require('./routes/meals');
const ingredientImagesRoutes = require('./routes/ingredientImages');
const onboardingRoutes = require('./routes/onboarding');
const shortcutsRoutes = require('./routes/shortcuts');
const savedRecipesRoutes = require('./routes/savedRecipes');
const shoppingListsRoutes = require('./routes/shoppingLists');
const pushRoutes = require('./routes/push');
const webhookRoutes = require('./routes/webhooks');
const subscriptionRoutes = require('./routes/subscriptions');
const supportRoutes = require('./routes/support');

const app = express();
const PORT = process.env.PORT || 5000;

// Configure multer for file uploads
const upload = multer({ 
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB limit
});

// Configure CORS for production
const corsOptions = {
  origin: function (origin, callback) {
    // Allow requests with no origin (like mobile apps or curl requests)
    if (!origin) return callback(null, true);

    const allowedOrigins = [
      'http://localhost:3000',
      'http://localhost:3001',
      'http://192.168.1.72:3000',
      'https://trackabite.vercel.app',
      'https://trackabite.app',
      'https://www.trackabite.app' // Added www subdomain support
    ];

    // Get additional allowed origins from environment
    if (process.env.FRONTEND_URL) {
      allowedOrigins.push(process.env.FRONTEND_URL);
    }

    // Allow any ngrok domain for testing
    if (origin && origin.includes('.ngrok-free.app')) {
      return callback(null, true);
    }

    // Allow any Vercel preview deployments
    if (origin && origin.includes('.vercel.app')) {
      return callback(null, true);
    }

    // Check against allowed origins
    if (allowedOrigins.some(allowed => origin === allowed || origin.startsWith(allowed))) {
      callback(null, true);
    } else {
      console.log('CORS blocked origin:', origin);
      callback(new Error('Not allowed by CORS'));
    }
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  optionsSuccessStatus: 200
};

// Middleware
app.use(cors(corsOptions));

// IMPORTANT: Webhook route MUST come BEFORE express.json() middleware
// Stripe webhooks require raw body for signature verification
app.use('/api/webhooks', webhookRoutes);

app.use(express.json({ limit: '10mb' }));  // Increased limit for larger payloads
app.use(express.urlencoded({ extended: true, limit: '10mb' }));  // Increased limit for form data

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/subscriptions', subscriptionRoutes);
app.use('/api/inventory', inventoryRoutes);
app.use('/api/inventory-analytics', inventoryAnalyticsRoutes);
app.use('/api/recipes', recipeRoutes);
app.use('/api/user-preferences', userPreferencesRoutes);
app.use('/api/ai-recipes', aiRecipeRoutes);
app.use('/api/meals', mealRoutes);
app.use('/api/ingredient-images', ingredientImagesRoutes);
app.use('/api/onboarding', onboardingRoutes);
app.use('/api/shortcuts', shortcutsRoutes);
app.use('/api/saved-recipes', savedRecipesRoutes);
app.use('/api/push', pushRoutes);
app.use('/api/shopping-lists', shoppingListsRoutes);
app.use('/api/support', supportRoutes);

// Image proxy endpoint for Instagram URLs (to bypass CORS)
app.get('/api/proxy-image', async (req, res) => {
  try {
    const { url } = req.query;

    if (!url) {
      return res.status(400).json({ error: 'URL parameter is required' });
    }

    // Only allow Instagram image URLs for security
    if (!url.includes('cdninstagram.com') &&
        !url.includes('instagram.com') &&
        !url.includes('fbcdn.net') &&
        !url.includes('instagram.')) {
      return res.status(400).json({ error: 'Only Instagram image URLs are allowed' });
    }

    console.log('[ImageProxy] Proxying Instagram image:', url.substring(0, 100) + '...');

    // Fetch the image from Instagram
    const fetch = require('node-fetch');
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
        'Accept': 'image/*,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        'Accept-Encoding': 'gzip, deflate, br',
        'DNT': '1',
        'Connection': 'keep-alive',
        'Upgrade-Insecure-Requests': '1'
      },
      timeout: 10000 // 10 second timeout
    });

    if (!response.ok) {
      console.error('[ImageProxy] Failed to fetch image:', {
        status: response.status,
        statusText: response.statusText,
        url: url.substring(0, 100) + '...',
        headers: Object.fromEntries(response.headers.entries())
      });
      return res.status(404).json({ error: 'Image not found or not accessible' });
    }

    // Get the content type
    const contentType = response.headers.get('content-type');
    if (!contentType || !contentType.startsWith('image/')) {
      return res.status(400).json({ error: 'URL does not point to a valid image' });
    }

    // Set appropriate headers
    res.set({
      'Content-Type': contentType,
      'Cache-Control': 'public, max-age=86400', // Cache for 24 hours
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET',
      'Access-Control-Allow-Headers': 'Content-Type'
    });

    // Stream the image data
    response.body.pipe(res);

    console.log('[ImageProxy] Successfully proxied image');

  } catch (error) {
    console.error('[ImageProxy] Error proxying image:', {
      message: error.message,
      code: error.code,
      errno: error.errno,
      url: req.query.url?.substring(0, 100) + '...'
    });
    res.status(500).json({ error: 'Failed to proxy image', details: error.message });
  }
});

// Initialize Supabase client
const supabaseUrl = process.env.SUPABASE_URL || 'your-supabase-url';
const supabaseKey = process.env.SUPABASE_ANON_KEY || 'your-supabase-anon-key';
const supabase = createClient(supabaseUrl, supabaseKey);

// Real AI processing function using Gemini 2.0 Flash
const analyzeGroceryImages = async (images) => {
  const aiRequestId = Math.random().toString(36).substring(7);
  
  try {
    console.log(`\n🤖 ================== AI ANALYSIS START ==================`);
    console.log(`🤖 AI REQUEST ID: ${aiRequestId}`);
    console.log(`🤖 Analyzing ${images.length} images with Gemini 2.0 Flash...`);
    console.log(`🤖 Timestamp: ${new Date().toISOString()}`);
    console.log(`🤖 ========================================================\n`);
    
    // Step 1: Validate API key
    console.log(`🔐 [${aiRequestId}] Step 1: Validating OpenRouter API key...`);
    if (!process.env.OPENROUTER_API_KEY) {
      throw new Error('OPENROUTER_API_KEY is missing from environment variables');
    }
    
    const apiKey = process.env.OPENROUTER_API_KEY;
    console.log(`🔐 [${aiRequestId}] API key present: ✅`);
    console.log(`🔐 [${aiRequestId}] API key length: ${apiKey.length}`);
    console.log(`🔐 [${aiRequestId}] API key format: ${apiKey.substring(0, 10)}...${apiKey.substring(apiKey.length - 4)}`);
    console.log(`🔐 [${aiRequestId}] API key starts with 'sk-or-v1': ${apiKey.startsWith('sk-or-v1') ? '✅' : '❌'}`);
    
    if (!apiKey.startsWith('sk-or-v1')) {
      throw new Error('Invalid OpenRouter API key format. Must start with "sk-or-v1"');
    }
    
    // Step 2: Prepare messages for Gemini 2.0 Flash
    console.log(`📝 [${aiRequestId}] Step 2: Preparing messages for Gemini 2.0 Flash...`);
    console.log(`📝 [${aiRequestId}] Number of images to analyze: ${images.length}`);
    
    images.forEach((image, index) => {
      console.log(`📝 [${aiRequestId}] Image ${index + 1}: ${image.substring(0, 50)}... (${image.length} chars)`);
    });
    
    const messages = [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: `Analyze these grocery/food images and identify each food item. For each item, provide:
            1. Item name (common grocery name)
            2. Food category (see categories below)
            3. Estimated quantity (number of items/pieces)
            4. Estimated total weight in ounces (oz) - IMPORTANT!
            5. Estimated expiration date (see expiry logic below)
            
            TODAY'S DATE: ${new Date().toISOString().split('T')[0]}
            
            CATEGORIES - Choose the most appropriate category for each item:
            - Dairy (ALL dairy products from animals: regular milk, chocolate milk, flavored milk, cheese, yogurt, drinkable yogurt, kefir, butter, cream, sour cream, cottage cheese, eggs, eggnog, etc.)
            - Fruits (apples, bananas, dragon fruit, berries, citrus, etc.)
            - Vegetables (lettuce, carrots, tomatoes, peppers, onions, etc.)
            - Protein (meat, fish, eggs, beans, nuts, tofu, etc.)
            - Fats and oils (cooking oil, olive oil, avocado oil, coconut oil, etc.)
            - Grains (bread, rice, pasta, cereal, oats, quinoa, etc.)
            - Beverages (NON-DAIRY drinks only: orange juice, apple juice, cranberry juice, soda, water bottles, energy drinks, sports drinks, almond milk, oat milk, soy milk, coconut milk, cold brew coffee, iced coffee, hot coffee, pumpkin cream cold brew, lattes, cappuccinos, iced tea, hot tea, lemonade, smoothies, etc.)
            - Seasonings (ALL seasonings, herbs, spices, and condiments - both wet and dry: fresh basil, oregano, thyme, rosemary, cilantro, parsley, dried herbs, cumin, paprika, cinnamon, garlic powder, onion powder, black pepper, red pepper flakes, soy sauce, ketchup, mustard, hot sauce, mayo, salt, sugar, honey, vinegar, etc.)
            - Other (for items that don't fit the above categories)

            IMPORTANT RULES:
            1. If it comes from a cow/goat/animal dairy source (even if drinkable), categorize as Dairy. Only non-dairy drinks go in Beverages.
            2. Coffee drinks (cold brew, iced coffee, lattes, cappuccinos, etc.) are ALWAYS Beverages, even if they contain cream or milk.
            3. Tea drinks (iced tea, hot tea, bubble tea, etc.) are ALWAYS Beverages.
            
            WEIGHT ESTIMATION GUIDE (per item):
            - Chicken breast: 6 oz each
            - Steak/beef cut: 8 oz each
            - Pork chop: 6 oz each
            - Fish fillet: 5 oz each
            - Apple: 7 oz each
            - Banana: 4 oz each
            - Orange: 8 oz each
            - Carrot: 3 oz each
            - Potato: 10 oz each
            - Onion: 8 oz each
            - Tomato: 5 oz each
            - Broccoli crown: 16 oz each
            - Bell pepper: 6 oz each
            - Bread loaf: 20 oz each
            - Milk (gallon): 128 oz
            - Milk (half gallon): 64 oz
            - Eggs: 2 oz each
            
            EXPIRY DATE LOGIC:
            1. First, look for printed expiration dates on packaging/labels
            2. If NO printed date is visible, estimate based on:
               - Current freshness/ripeness visible in the photo
               - Typical shelf life for that food type
               - Today's date as the starting point
            3. Examples of realistic estimation from today (${new Date().toISOString().split('T')[0]}):
               - Fresh ripe fruit: 3-7 days from today
               - Fresh vegetables: 5-10 days from today  
               - Packaged items: weeks to months from today
               - Items that look very ripe/soft: 1-3 days from today
            
            Return ONLY a JSON array in this exact format:
            [
              {"item": "Chicken breast", "category": "Protein", "quantity": 2, "total_weight_oz": 12, "expires": "YYYY-MM-DD"},
              {"item": "Broccoli", "category": "Vegetables", "quantity": 1, "total_weight_oz": 16, "expires": "YYYY-MM-DD"}
            ]
            
            Guidelines:
            - Use common grocery names (e.g., "Milk" not "Dairy beverage")
            - Be precise with categories (dragon fruit = "Fruits", not "Produce")
            - Quantity should be the count of items (e.g., 2 for 2 chicken breasts)
            - total_weight_oz should be quantity × weight per item (e.g., 2 × 6oz = 12oz)
            - Expiry dates must be FUTURE dates from today (${new Date().toISOString().split('T')[0]})
            - Consider visual ripeness/freshness when estimating expiry
            - If you can't clearly identify an item, skip it
            - Maximum 10 items per response`
          },
          ...images.map(image => ({
            type: "image_url",
            image_url: {
              url: image.startsWith('data:') ? image : `data:image/jpeg;base64,${image}`
            }
          }))
        ]
      }
    ];

    // Step 3: Prepare request body
    console.log(`⚙️  [${aiRequestId}] Step 3: Preparing request body...`);
    const requestBody = {
      model: "google/gemini-2.0-flash-001",
      messages: messages,
      max_tokens: 1000,
      temperature: 0.1
    };
    
    console.log(`⚙️  [${aiRequestId}] Request body prepared:`);
    console.log(`⚙️  [${aiRequestId}]   Model: ${requestBody.model}`);
    console.log(`⚙️  [${aiRequestId}]   Messages count: ${requestBody.messages.length}`);
    console.log(`⚙️  [${aiRequestId}]   Max tokens: ${requestBody.max_tokens}`);
    console.log(`⚙️  [${aiRequestId}]   Temperature: ${requestBody.temperature}`);

    // Step 4: Make API request
    console.log(`🌐 [${aiRequestId}] Step 4: Making fetch request to OpenRouter...`);
    console.log(`🌐 [${aiRequestId}] URL: https://openrouter.ai/api/v1/chat/completions`);
    console.log(`🌐 [${aiRequestId}] Method: POST`);
    console.log(`🌐 [${aiRequestId}] Headers:`);
    console.log(`🌐 [${aiRequestId}]   Authorization: Bearer ${apiKey.substring(0, 10)}...`);
    console.log(`🌐 [${aiRequestId}]   Content-Type: application/json`);
    console.log(`🌐 [${aiRequestId}]   HTTP-Referer: https://fridgy-app.com`);
    console.log(`🌐 [${aiRequestId}]   X-Title: Fridgy - AI Fridge Inventory`);
    
    console.log(`🌐 [${aiRequestId}] Making fetch request now...`);
    const fetchStartTime = Date.now();
    
    const fetchResponse = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://fridgy-app.com',
        'X-Title': 'Fridgy - AI Fridge Inventory'
      },
      body: JSON.stringify(requestBody)
    });
    
    const fetchDuration = Date.now() - fetchStartTime;
    console.log(`🌐 [${aiRequestId}] Fetch completed in ${fetchDuration}ms`);
    console.log(`🌐 [${aiRequestId}] Response status: ${fetchResponse.status} ${fetchResponse.statusText}`);
    console.log(`🌐 [${aiRequestId}] Response headers:`, Object.fromEntries(fetchResponse.headers.entries()));

    if (!fetchResponse.ok) {
      console.error(`❌ [${aiRequestId}] OpenRouter API error!`);
      console.error(`❌ [${aiRequestId}] Status: ${fetchResponse.status} ${fetchResponse.statusText}`);
      
      const errorText = await fetchResponse.text();
      console.error(`❌ [${aiRequestId}] Error response body:`, errorText);
      
      throw new Error(`OpenRouter API error: ${fetchResponse.status} ${fetchResponse.statusText} - ${errorText}`);
    }

    console.log(`📥 [${aiRequestId}] Step 5: Parsing JSON response...`);
    const completion = await fetchResponse.json();
    console.log(`📥 [${aiRequestId}] Response structure:`, Object.keys(completion));
    console.log(`📥 [${aiRequestId}] Choices count: ${completion.choices ? completion.choices.length : 0}`);
    
    if (!completion.choices || completion.choices.length === 0) {
      throw new Error('No choices returned from OpenRouter API');
    }
    
    const response = completion.choices[0].message.content;
    console.log(`📥 [${aiRequestId}] Raw AI response:`, response);
    
    // Step 6: Parse JSON response
    console.log(`🔄 [${aiRequestId}] Step 6: Parsing AI response as JSON...`);
    try {
      const items = JSON.parse(response);
      console.log(`✅ [${aiRequestId}] JSON parsing successful!`);
      console.log(`✅ [${aiRequestId}] Parsed items:`, items);
      console.log(`✅ [${aiRequestId}] Items count: ${Array.isArray(items) ? items.length : 'Not an array'}`);
      console.log(`✅ [${aiRequestId}] Items type: ${typeof items}`);
      
      if (Array.isArray(items)) {
        items.forEach((item, index) => {
          console.log(`✅ [${aiRequestId}] Item ${index + 1}:`, item);
        });
        console.log(`\n🎉 [${aiRequestId}] =============== AI ANALYSIS SUCCESS ===============\n`);
        return items;
      } else {
        console.log(`⚠️  [${aiRequestId}] Response is not an array, returning empty array`);
        return [];
      }
      
    } catch (parseError) {
      console.error(`❌ [${aiRequestId}] JSON parsing failed!`);
      console.error(`❌ [${aiRequestId}] Parse error:`, parseError.message);
      console.error(`❌ [${aiRequestId}] Raw response that failed to parse:`, response);
      
      // Fallback: try to extract JSON from response
      console.log(`🔄 [${aiRequestId}] Attempting fallback JSON extraction...`);
      const jsonMatch = response.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        console.log(`🔄 [${aiRequestId}] Found JSON pattern, attempting to parse:`, jsonMatch[0]);
        try {
          const fallbackItems = JSON.parse(jsonMatch[0]);
          console.log(`✅ [${aiRequestId}] Fallback parsing successful:`, fallbackItems);
          return fallbackItems;
        } catch (fallbackError) {
          console.error(`❌ [${aiRequestId}] Fallback parsing also failed:`, fallbackError.message);
        }
      } else {
        console.log(`❌ [${aiRequestId}] No JSON pattern found in response`);
      }
      
      console.log(`🔄 [${aiRequestId}] Returning empty array as final fallback`);
      return [];
    }
    
  } catch (error) {
    console.error(`\n💥 [${aiRequestId}] ========== AI ANALYSIS ERROR ==========`);
    console.error(`💥 [${aiRequestId}] Error in analyzeGroceryImages:`, error);
    console.error(`💥 [${aiRequestId}] Error type:`, error.constructor.name);
    console.error(`💥 [${aiRequestId}] Error message:`, error.message);
    console.error(`💥 [${aiRequestId}] Error stack:`, error.stack);
    console.error(`💥 [${aiRequestId}] ==========================================\n`);
    
    // Instead of fallback data, throw error to be handled by caller
    throw new Error(`AI_PROCESSING_FAILED: ${error.message}`);
  }
};

// Recipe Image Analysis Function
const analyzeRecipeImage = async (imageBase64) => {
  const aiRequestId = Math.random().toString(36).substring(7);

  try {
    console.log(`\n🍳 ================== RECIPE ANALYSIS START ==================`);
    console.log(`🍳 RECIPE REQUEST ID: ${aiRequestId}`);
    console.log(`🍳 Analyzing recipe image with Gemini 2.0 Flash...`);
    console.log(`🍳 Timestamp: ${new Date().toISOString()}`);
    console.log(`🍳 ========================================================\n`);

    // Validate API key
    if (!process.env.OPENROUTER_API_KEY) {
      throw new Error('OPENROUTER_API_KEY is missing from environment variables');
    }

    const apiKey = process.env.OPENROUTER_API_KEY;
    console.log(`🔐 [${aiRequestId}] API key present: ✅`);

    // Prepare messages for Gemini
    const messages = [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: `Analyze this recipe image and extract the complete recipe information. This could be from a cookbook, magazine, handwritten note, or any recipe source.

EXTRACTION REQUIREMENTS:
1. Recipe title/name - extract the exact title if visible
2. Complete ingredients list with quantities and units
3. Step-by-step cooking instructions in order
4. Cooking time and servings (if visible)
5. Any dietary information mentioned

IMPORTANT GUIDELINES:
- Extract ALL visible text related to the recipe
- Preserve exact quantities and measurements
- Keep instructions in the original order
- If handwritten, do your best to interpret the handwriting
- If parts are unclear, make reasonable assumptions based on context

Return the result as a JSON object with this EXACT structure:
{
  "title": "Recipe Name",
  "summary": "Brief description of the dish",
  "image": null,
  "extendedIngredients": [
    {
      "original": "2 cups all-purpose flour",
      "name": "flour",
      "amount": 2,
      "unit": "cups"
    }
  ],
  "analyzedInstructions": [
    {
      "name": "",
      "steps": [
        {
          "number": 1,
          "step": "First step instructions"
        }
      ]
    }
  ],
  "readyInMinutes": 30,
  "servings": 4,
  "vegetarian": false,
  "vegan": false,
  "glutenFree": false,
  "dairyFree": false
}

Respond with ONLY the JSON object, no additional text.`
          },
          {
            type: "image_url",
            image_url: {
              url: imageBase64
            }
          }
        ]
      }
    ];

    console.log(`📝 [${aiRequestId}] Calling OpenRouter API...`);

    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'http://localhost:5000',
        'X-Title': 'Fridgy Recipe Scanner'
      },
      body: JSON.stringify({
        model: 'google/gemini-2.0-flash-exp:free',
        messages: messages,
        temperature: 0.3,
        max_tokens: 2000
      })
    });

    if (!response.ok) {
      const errorData = await response.text();
      console.error(`❌ [${aiRequestId}] OpenRouter API error:`, errorData);
      throw new Error(`OpenRouter API failed: ${response.status}`);
    }

    const responseData = await response.json();
    console.log(`✅ [${aiRequestId}] OpenRouter API response received`);

    if (!responseData.choices || !responseData.choices[0] || !responseData.choices[0].message) {
      throw new Error('Invalid response from OpenRouter API');
    }

    const content = responseData.choices[0].message.content;
    console.log(`📊 [${aiRequestId}] Parsing AI response...`);

    // Parse the JSON response
    let recipeData;
    try {
      // Clean the response in case there's extra text
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        recipeData = JSON.parse(jsonMatch[0]);
      } else {
        throw new Error('No JSON found in response');
      }
    } catch (parseError) {
      console.error(`❌ [${aiRequestId}] Failed to parse AI response:`, parseError);
      console.log(`❌ [${aiRequestId}] Raw content:`, content);
      throw new Error('Failed to parse recipe data');
    }

    // Ensure required fields exist
    if (!recipeData.title) {
      recipeData.title = "Scanned Recipe";
    }

    if (!recipeData.extendedIngredients || !Array.isArray(recipeData.extendedIngredients)) {
      recipeData.extendedIngredients = [];
    }

    if (!recipeData.analyzedInstructions || !Array.isArray(recipeData.analyzedInstructions)) {
      recipeData.analyzedInstructions = [{ name: "", steps: [] }];
    }

    console.log(`✅ [${aiRequestId}] Recipe extracted successfully:`, {
      title: recipeData.title,
      ingredientCount: recipeData.extendedIngredients.length,
      stepCount: recipeData.analyzedInstructions[0]?.steps?.length || 0
    });

    return recipeData;

  } catch (error) {
    console.error(`\n💥 [${aiRequestId}] ========== RECIPE ANALYSIS ERROR ==========`);
    console.error(`💥 [${aiRequestId}] Error:`, error.message);
    console.error(`💥 [${aiRequestId}] ==========================================\n`);
    throw error;
  }
};

// Helper function for OpenRouter API with fallback
const callOpenRouterWithFallback = async (requestData, requestId) => {
  const apiKey = process.env.OPENROUTER_API_KEY;

  // Try free model first
  console.log(`🆓 [${requestId}] Trying free model: google/gemini-2.0-flash-exp:free`);
  try {
    const freeResponse = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'http://localhost:5000',
        'X-Title': 'Fridgy Recipe Scanner'
      },
      body: JSON.stringify({
        ...requestData,
        model: 'google/gemini-2.0-flash-exp:free'
      })
    });

    if (freeResponse.ok) {
      console.log(`✅ [${requestId}] Free model successful!`);
      return await freeResponse.json();
    }

    // Check if it's a rate limit error
    if (freeResponse.status === 429) {
      const errorData = await freeResponse.text();
      console.log(`⚠️ [${requestId}] Free model rate limited (429), trying paid fallback...`);
      console.log(`⚠️ [${requestId}] Rate limit details:`, errorData);

      // Fallback to paid model
      console.log(`💳 [${requestId}] Trying paid model: google/gemini-flash-1.5`);
      const paidResponse = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'http://localhost:5000',
          'X-Title': 'Fridgy Recipe Scanner'
        },
        body: JSON.stringify({
          ...requestData,
          model: 'google/gemini-flash-1.5'
        })
      });

      if (paidResponse.ok) {
        console.log(`✅ [${requestId}] Paid model fallback successful!`);
        return await paidResponse.json();
      } else {
        const paidErrorData = await paidResponse.text();
        console.error(`❌ [${requestId}] Paid model also failed:`, paidErrorData);
        throw new Error(`Both free and paid models failed: ${paidResponse.status}`);
      }
    } else {
      // Non-rate-limit error, throw original error
      const errorData = await freeResponse.text();
      console.error(`❌ [${requestId}] Free model error (non-rate-limit):`, errorData);
      throw new Error(`OpenRouter API failed: ${freeResponse.status}`);
    }
  } catch (error) {
    // Network or other errors
    console.error(`❌ [${requestId}] Network/fetch error:`, error.message);
    throw error;
  }
};

// Multi-Page Recipe Image Analysis Function - Returns recipe data AND best photo index
const analyzeRecipeImages = async (imageBase64Array) => {
  const aiRequestId = Math.random().toString(36).substring(7);

  try {
    console.log(`\n🍳 ================== MULTI-PAGE RECIPE ANALYSIS START ==================`);
    console.log(`🍳 RECIPE REQUEST ID: ${aiRequestId}`);
    console.log(`🍳 Analyzing ${imageBase64Array.length} recipe page(s) with Gemini 2.0 Flash...`);
    console.log(`🍳 Timestamp: ${new Date().toISOString()}`);
    console.log(`🍳 ====================================================================\n`);

    // Validate API key
    if (!process.env.OPENROUTER_API_KEY) {
      throw new Error('OPENROUTER_API_KEY is missing from environment variables');
    }

    const apiKey = process.env.OPENROUTER_API_KEY;
    console.log(`🔐 [${aiRequestId}] API key present: ✅`);

    // Build content array with all images
    const contentArray = [
      {
        type: "text",
        text: `Analyze these recipe images and extract the complete recipe information. These images may represent multiple pages of the same recipe from a cookbook, magazine, handwritten notes, or any recipe source.

MULTI-PAGE HANDLING:
- These ${imageBase64Array.length} image(s) may contain different parts of the same recipe
- Page 1 might have the title and ingredients
- Page 2 might have the cooking instructions
- Combine ALL information from ALL pages into a single complete recipe

EXTRACTION REQUIREMENTS:
1. Recipe title/name - extract the exact title (usually on first page)
2. Complete ingredients list with quantities and units (combine from all pages)
3. Step-by-step cooking instructions in order (may span multiple pages)
4. Cooking time and servings (if visible on any page)
5. Any dietary information mentioned

IMPORTANT GUIDELINES:
- Extract and COMBINE all visible text related to the recipe from ALL pages
- Preserve exact quantities and measurements
- Keep instructions in the original order, even if split across pages
- If handwritten, do your best to interpret the handwriting
- If parts are unclear, make reasonable assumptions based on context
- Ensure continuity between pages (e.g., step 5 on page 2 follows step 4 from page 1)

Return the result as a JSON object with this EXACT structure:
{
  "title": "Recipe Name",
  "summary": "Brief description of the dish",
  "image": null,
  "extendedIngredients": [
    {
      "original": "2 cups all-purpose flour",
      "name": "flour",
      "amount": 2,
      "unit": "cups"
    }
  ],
  "analyzedInstructions": [
    {
      "name": "",
      "steps": [
        {
          "number": 1,
          "step": "First step instructions"
        }
      ]
    }
  ],
  "readyInMinutes": 30,
  "servings": 4,
  "vegetarian": false,
  "vegan": false,
  "glutenFree": false,
  "dairyFree": false
}

Respond with ONLY the JSON object, no additional text.`
      }
    ];

    // Add all images to the content array
    imageBase64Array.forEach((imageBase64, index) => {
      contentArray.push({
        type: "image_url",
        image_url: {
          url: imageBase64
        }
      });
      console.log(`📄 [${aiRequestId}] Added page ${index + 1} to analysis`);
    });

    // Prepare messages for Gemini
    const messages = [
      {
        role: "user",
        content: contentArray
      }
    ];

    console.log(`📝 [${aiRequestId}] Calling OpenRouter API with ${imageBase64Array.length} pages...`);

    const responseData = await callOpenRouterWithFallback({
      messages: messages,
      temperature: 0.3,
      max_tokens: 3000  // Increased for potentially longer multi-page recipes
    }, aiRequestId);
    console.log(`✅ [${aiRequestId}] OpenRouter API response received`);

    if (!responseData.choices || !responseData.choices[0] || !responseData.choices[0].message) {
      throw new Error('Invalid response from OpenRouter API');
    }

    const content = responseData.choices[0].message.content;
    console.log(`📊 [${aiRequestId}] Parsing AI response...`);

    // Parse the JSON response
    let recipeData;
    try {
      // Clean the response in case there's extra text
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        recipeData = JSON.parse(jsonMatch[0]);
      } else {
        throw new Error('No JSON found in response');
      }
    } catch (parseError) {
      console.error(`❌ [${aiRequestId}] Failed to parse AI response:`, parseError);
      console.log(`❌ [${aiRequestId}] Raw content:`, content);
      throw new Error('Failed to parse recipe data');
    }

    // Ensure required fields exist
    if (!recipeData.title) {
      recipeData.title = "Scanned Recipe";
    }

    if (!recipeData.extendedIngredients || !Array.isArray(recipeData.extendedIngredients)) {
      recipeData.extendedIngredients = [];
    }

    if (!recipeData.analyzedInstructions || !Array.isArray(recipeData.analyzedInstructions)) {
      recipeData.analyzedInstructions = [{ name: "", steps: [] }];
    }

    console.log(`✅ [${aiRequestId}] Multi-page recipe extracted successfully:`, {
      title: recipeData.title,
      pages: imageBase64Array.length,
      ingredientCount: recipeData.extendedIngredients.length,
      stepCount: recipeData.analyzedInstructions[0]?.steps?.length || 0
    });

    // Step 2: Identify the best photo that shows the finished dish
    let bestPhotoIndex = 0; // Default to first photo if AI can't determine

    if (imageBase64Array.length > 1) {
      console.log(`🖼️ [${aiRequestId}] Identifying best photo from ${imageBase64Array.length} images...`);

      try {
        const photoSelectionContent = [
          {
            type: "text",
            text: `You have ${imageBase64Array.length} images from a recipe. Please identify which image best shows the FINISHED DISH or FOOD itself (not ingredient lists, instruction text, or recipe title pages).

            Look for:
            - Plated food or completed dish
            - Food photography showing the final result
            - The most appetizing view of the prepared meal

            Avoid selecting:
            - Pages with mostly text (ingredients list or instructions)
            - Title pages or headers
            - Close-ups of raw ingredients

            Return ONLY a JSON object with this format:
            {
              "bestPhotoIndex": 0,
              "confidence": "high",
              "reason": "Shows the finished plated dish"
            }

            The index is 0-based (0 for first image, 1 for second, etc.)`
          }
        ];

        // Add all images for comparison
        imageBase64Array.forEach((base64, index) => {
          photoSelectionContent.push({
            type: "image_url",
            image_url: { url: base64 }
          });
        });

        const photoResponse = await fetch('https://openrouter.ai/api/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
            'HTTP-Referer': 'http://localhost:5000',
            'X-Title': 'Fridgy Recipe Scanner - Photo Selection'
          },
          body: JSON.stringify({
            model: 'google/gemini-2.0-flash-exp:free',
            messages: [{ role: "user", content: photoSelectionContent }],
            temperature: 0.1,
            max_tokens: 200
          })
        });

        if (photoResponse.ok) {
          const photoData = await photoResponse.json();
          const photoContent = photoData.choices[0]?.message?.content;

          try {
            const photoMatch = photoContent.match(/\{[\s\S]*\}/);
            if (photoMatch) {
              const photoSelection = JSON.parse(photoMatch[0]);
              bestPhotoIndex = photoSelection.bestPhotoIndex || 0;
              console.log(`🖼️ [${aiRequestId}] Best photo identified: Index ${bestPhotoIndex} - ${photoSelection.reason}`);
            }
          } catch (e) {
            console.log(`⚠️ [${aiRequestId}] Could not parse photo selection, using first photo`);
          }
        }
      } catch (photoError) {
        console.log(`⚠️ [${aiRequestId}] Photo selection failed, using first photo:`, photoError.message);
      }
    }

    return {
      recipeData,
      bestPhotoIndex
    };

  } catch (error) {
    console.error(`\n💥 [${aiRequestId}] ========== MULTI-PAGE RECIPE ANALYSIS ERROR ==========`);
    console.error(`💥 [${aiRequestId}] Error:`, error.message);
    console.error(`💥 [${aiRequestId}] =====================================================\n`);
    throw error;
  }
};



// Routes
app.get('/api/health', (req, res) => {
  res.json({ status: 'Server is running!' });
});

// AI Health Check endpoint
app.get('/api/health/ai', async (req, res) => {
  console.log('\n🏥 AI Health Check requested');
  try {
    // Check environment variables
    const checks = {
      timestamp: new Date().toISOString(),
      openrouter_api_key: !!process.env.OPENROUTER_API_KEY,
      api_key_format: process.env.OPENROUTER_API_KEY ? process.env.OPENROUTER_API_KEY.startsWith('sk-or-v1') : false,
      api_key_length: process.env.OPENROUTER_API_KEY ? process.env.OPENROUTER_API_KEY.length : 0,
      node_version: process.version,
      fetch_available: typeof fetch !== 'undefined'
    };
    
    console.log('🏥 AI Health Check results:', checks);
    
    res.json({
      status: 'AI Health Check Complete',
      healthy: checks.openrouter_api_key && checks.api_key_format && checks.fetch_available,
      checks: checks
    });
  } catch (error) {
    console.error('🏥 AI Health Check error:', error);
    res.status(500).json({
      status: 'AI Health Check Failed',
      error: error.message,
      healthy: false
    });
  }
});


// Unified endpoint: Process batch images with real AI
app.post('/api/process-images', upload.array('images', 10), async (req, res) => {
  const requestId = Math.random().toString(36).substring(7);
  const timestamp = new Date().toISOString();
  
  console.log(`\n🔥 ================== REQUEST START ==================`);
  console.log(`🔥 REQUEST ID: ${requestId}`);
  console.log(`🔥 TIMESTAMP: ${timestamp}`);
  console.log(`🔥 ENDPOINT: /api/process-images`);
  console.log(`🔥 METHOD: ${req.method}`);
  console.log(`🔥 CONTENT TYPE: ${req.get('Content-Type') || 'Not set'}`);
  console.log(`🔥 =====================================================\n`);
  
  try {
    console.log(`📸 [${requestId}] Step 1: Checking received files...`);
    console.log(`📸 [${requestId}] Files count: ${req.files ? req.files.length : 0}`);
    console.log(`📸 [${requestId}] Request body keys:`, Object.keys(req.body || {}));
    console.log(`📸 [${requestId}] Request files:`, req.files ? req.files.map(f => `${f.originalname} (${f.size} bytes, ${f.mimetype})`) : 'none');
    
    let analysisResults;
    
    if (req.files && req.files.length > 0) {
      console.log(`🔄 [${requestId}] Step 2: Converting files to base64...`);
      
      // Convert uploaded files to base64 for AI analysis
      const base64Images = req.files.map((file, index) => {
        console.log(`🔄 [${requestId}] Converting file ${index + 1}: ${file.originalname}`);
        const base64 = `data:${file.mimetype};base64,${file.buffer.toString('base64')}`;
        console.log(`🔄 [${requestId}] Base64 length for ${file.originalname}: ${base64.length} characters`);
        return base64;
      });
      
      console.log(`🤖 [${requestId}] Step 3: Starting AI analysis...`);
      console.log(`🤖 [${requestId}] Using Gemini 2.0 Flash for real AI analysis`);
      console.log(`🤖 [${requestId}] Prepared ${base64Images.length} images for analysis`);
      console.log(`🤖 [${requestId}] About to call analyzeGroceryImages()`);
      
      try {
        console.log(`🚀 [${requestId}] Calling analyzeGroceryImages() now...`);
        const aiResults = await analyzeGroceryImages(base64Images);
        console.log(`✅ [${requestId}] AI analysis completed successfully!`);
        console.log(`✅ [${requestId}] AI returned ${aiResults ? aiResults.length : 0} items`);
        
        // Transform AI results to work with BatchCamera
        analysisResults = aiResults.map(aiItem => ({
          // Core fields for database saving  
          item: aiItem.item,
          quantity: aiItem.quantity,
          expires: aiItem.expires,
          // Display fields for BatchCamera table (AI now provides category directly)
          category: aiItem.category,
          name: aiItem.item,
          expiryDate: aiItem.expires
        }));
        
      } catch (aiError) {
        console.error(`❌ [${requestId}] AI processing failed!`);
        console.error(`❌ [${requestId}] AI Error type:`, aiError.constructor.name);
        console.error(`❌ [${requestId}] AI Error message:`, aiError.message);
        console.error(`❌ [${requestId}] AI Error stack:`, aiError.stack);
        console.log(`🚫 [${requestId}] Returning 500 error to user`);
        
        return res.status(500).json({
          success: false,
          error: "Can't process images right now. Please try again in a moment.",
          errorType: 'AI_PROCESSING_FAILED',
          requestId: requestId
        });
      }
      
    } else {
      console.log(`⚠️  [${requestId}] No files provided in request`);
      return res.status(400).json({
        success: false,
        error: 'No images provided. Please upload at least one photo.',
        requestId: requestId
      });
    }
    
    console.log(`🎉 [${requestId}] Step 4: Preparing successful response...`);
    console.log(`🎉 [${requestId}] Analysis results count: ${analysisResults.length}`);
    console.log(`🎉 [${requestId}] Sending successful response`);
    
    const response = {
      success: true,
      items: analysisResults,
      aiUsed: req.files && req.files.length > 0 ? 'gemini-2.0-flash' : 'mock',
      requestId: requestId,
      timestamp: new Date().toISOString()
    };
    
    res.json(response);
    console.log(`\n✅ [${requestId}] =============== REQUEST COMPLETE ===============\n`);
    
  } catch (error) {
    console.error(`\n💥 [${requestId}] ========== MAIN ERROR ==========`);
    console.error(`💥 [${requestId}] Error in /api/process-images:`, error);
    console.error(`💥 [${requestId}] Error type:`, error.constructor.name);
    console.error(`💥 [${requestId}] Error message:`, error.message);
    console.error(`💥 [${requestId}] Error stack:`, error.stack);
    console.error(`💥 [${requestId}] ================================\n`);
    
    res.status(500).json({
      success: false,
      error: 'Failed to process images - check backend logs for details',
      requestId: requestId,
      errorType: 'MAIN_ERROR'
    });
  }
});

// Recipe Scanning Endpoint - Supports multiple images for multi-page recipes
app.post('/api/scan-recipe', authMiddleware.authenticateToken, upload.array('images', 10), async (req, res) => {
  const requestId = Math.random().toString(36).substring(7);

  console.log(`\n🍳 ================== RECIPE SCAN REQUEST START ==================`);
  console.log(`🍳 REQUEST ID: ${requestId}`);
  console.log(`🍳 ENDPOINT: /api/scan-recipe`);
  console.log(`🍳 USER ID: ${req.user?.id || 'Not authenticated'}`);
  console.log(`🍳 USER EMAIL: ${req.user?.email || 'Not authenticated'}`);
  console.log(`🍳 TIMESTAMP: ${new Date().toISOString()}`);
  console.log(`🍳 =================================================================\n`);

  try {
    // Check if files were uploaded
    if (!req.files || req.files.length === 0) {
      console.log(`⚠️  [${requestId}] No image files provided`);
      return res.status(400).json({
        success: false,
        error: 'No images provided. Please upload recipe photos.',
        requestId: requestId
      });
    }

    console.log(`📸 [${requestId}] Received ${req.files.length} image(s) for recipe scanning`);
    req.files.forEach((file, index) => {
      console.log(`📸 [${requestId}] Image ${index + 1}: ${file.originalname} (${file.size} bytes)`);
    });

    // Validate images before processing
    console.log(`🔍 [${requestId}] Validating uploaded images...`);
    const maxFileSize = 10 * 1024 * 1024; // 10MB
    const allowedMimeTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];

    for (let i = 0; i < req.files.length; i++) {
      const file = req.files[i];

      // Check file size
      if (file.size > maxFileSize) {
        console.error(`💥 [${requestId}] Image ${i + 1} too large: ${file.size} bytes (max: ${maxFileSize})`);
        throw new Error(`Image ${i + 1} is too large. Maximum size is 10MB.`);
      }

      // Check file type
      if (!allowedMimeTypes.includes(file.mimetype)) {
        console.error(`💥 [${requestId}] Image ${i + 1} invalid type: ${file.mimetype}`);
        throw new Error(`Image ${i + 1} has invalid format. Please use JPEG, PNG, or WebP.`);
      }

      // Check if file buffer exists
      if (!file.buffer || file.buffer.length === 0) {
        console.error(`💥 [${requestId}] Image ${i + 1} has no data`);
        throw new Error(`Image ${i + 1} appears to be corrupted or empty.`);
      }

      console.log(`✅ [${requestId}] Image ${i + 1} validation passed: ${file.mimetype}, ${file.size} bytes`);
    }

    // Convert all images to base64
    const base64Images = req.files.map(file => {
      const base64 = `data:${file.mimetype};base64,${file.buffer.toString('base64')}`;
      console.log(`🔄 [${requestId}] Converted image to base64, length: ${base64.length} characters`);
      return base64;
    });

    // Health check OpenRouter API before analysis
    console.log(`🔍 [${requestId}] Performing OpenRouter API health check...`);
    try {
      if (!process.env.OPENROUTER_API_KEY) {
        throw new Error('OPENROUTER_API_KEY is missing from environment variables');
      }

      // Quick health check with minimal API call
      const healthResponse = await fetch('https://openrouter.ai/api/v1/models', {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`
        },
        timeout: 5000  // 5 second timeout
      });

      if (!healthResponse.ok) {
        throw new Error(`OpenRouter API health check failed: ${healthResponse.status}`);
      }

      console.log(`✅ [${requestId}] OpenRouter API health check passed`);
    } catch (healthError) {
      console.error(`💥 [${requestId}] OpenRouter API health check failed:`, healthError.message);
      throw new Error(`OpenRouter API failed: ${healthError.message}`);
    }

    console.log(`🤖 [${requestId}] Starting AI recipe analysis with ${base64Images.length} page(s)...`);

    // Analyze all recipe images (will combine text from multiple pages) AND get best photo index
    const analysisResult = await analyzeRecipeImages(base64Images);
    const { recipeData, bestPhotoIndex } = analysisResult;

    console.log(`✅ [${requestId}] Recipe analysis completed successfully!`);
    console.log(`✅ [${requestId}] Recipe title: ${recipeData.title}`);
    console.log(`✅ [${requestId}] Ingredients count: ${recipeData.extendedIngredients?.length || 0}`);
    console.log(`✅ [${requestId}] Instructions steps: ${recipeData.analyzedInstructions?.[0]?.steps?.length || 0}`);
    console.log(`🖼️ [${requestId}] Best photo index: ${bestPhotoIndex}`);

    // Upload the best photo to Supabase Storage
    let imageUrl = null;
    let imageStoragePath = null;

    try {
      const bestPhoto = req.files[bestPhotoIndex];
      if (bestPhoto) {
        console.log(`📸 [${requestId}] Uploading best photo to storage...`);

        // Generate unique filename
        const userId = req.user?.id || 'anonymous';
        const timestamp = Date.now();
        const randomId = Math.random().toString(36).substring(7);
        const fileName = `${userId}/${timestamp}_${randomId}_recipe.jpg`;

        console.log(`📸 [${requestId}] Storage path: ${fileName}`);

        // Upload to Supabase Storage
        const { data: uploadData, error: uploadError } = await supabase.storage
          .from('recipe-images')
          .upload(fileName, bestPhoto.buffer, {
            contentType: bestPhoto.mimetype || 'image/jpeg',
            upsert: false
          });

        if (uploadError) {
          console.error(`❌ [${requestId}] Storage upload error:`, JSON.stringify(uploadError, null, 2));
          console.error(`❌ [${requestId}] Error message:`, uploadError.message || 'Unknown error');
          console.error(`❌ [${requestId}] Error statusCode:`, uploadError.statusCode);
        } else {
          // Get public URL
          const { data: urlData } = supabase.storage
            .from('recipe-images')
            .getPublicUrl(fileName);

          imageUrl = urlData.publicUrl;
          imageStoragePath = fileName;
          console.log(`✅ [${requestId}] Image uploaded successfully`);
          console.log(`✅ [${requestId}] Image URL: ${imageUrl}`);
        }
      }
    } catch (storageError) {
      console.error(`❌ [${requestId}] Storage error:`, storageError.message || storageError);
      console.error(`❌ [${requestId}] Full storage error:`, JSON.stringify(storageError, null, 2));
      // Continue without image - don't fail the entire request
    }

    // Add image URL to recipe data
    if (imageUrl) {
      recipeData.image = imageUrl;
      recipeData.imageStoragePath = imageStoragePath;
    }

    // Send successful response
    res.json({
      success: true,
      recipe: recipeData,
      requestId: requestId,
      timestamp: new Date().toISOString()
    });

    console.log(`\n✅ [${requestId}] =============== RECIPE SCAN COMPLETE ===============\n`);

  } catch (error) {
    console.error(`\n💥 [${requestId}] ========== RECIPE SCAN ERROR ==========`);
    console.error(`💥 [${requestId}] Error Type:`, error.constructor.name);
    console.error(`💥 [${requestId}] Error Message:`, error.message);
    console.error(`💥 [${requestId}] Error Stack:`, error.stack);

    // Log specific error context
    if (error.message.includes('OPENROUTER_API_KEY')) {
      console.error(`💥 [${requestId}] ISSUE: Missing or invalid OpenRouter API Key`);
    } else if (error.message.includes('OpenRouter API failed')) {
      console.error(`💥 [${requestId}] ISSUE: OpenRouter API request failed`);
    } else if (error.message.includes('Failed to parse recipe data')) {
      console.error(`💥 [${requestId}] ISSUE: AI response parsing failed`);
    } else if (error.message.includes('Invalid response from OpenRouter')) {
      console.error(`💥 [${requestId}] ISSUE: Invalid API response structure`);
    } else {
      console.error(`💥 [${requestId}] ISSUE: Unknown error in recipe analysis`);
    }

    console.error(`💥 [${requestId}] Request Details:`, {
      imageCount: req.files?.length || 0,
      userID: req.user?.id || 'unknown',
      hasAPIKey: !!process.env.OPENROUTER_API_KEY,
      timestamp: new Date().toISOString()
    });
    console.error(`💥 [${requestId}] ========================================\n`);

    // Return more specific error message based on error type
    let userErrorMessage = 'Failed to analyze recipe image. Please try again with a clearer photo.';
    if (error.message.includes('OPENROUTER_API_KEY')) {
      userErrorMessage = 'AI service configuration error. Please contact support.';
    } else if (error.message.includes('OpenRouter API failed')) {
      userErrorMessage = 'AI service temporarily unavailable. Please try again in a few minutes.';
    }

    res.status(500).json({
      success: false,
      error: userErrorMessage,
      requestId: requestId,
      errorType: error.constructor.name,
      timestamp: new Date().toISOString()
    });
  }
});

// Save confirmed items to Supabase database
app.post('/api/save-items', async (req, res) => {
  const saveRequestId = Math.random().toString(36).substring(7);
  
  try {
    const { items, userId = 'anonymous' } = req.body;
    
    console.log(`\n💾 ================== SAVE REQUEST START ==================`);
    console.log(`💾 SAVE REQUEST ID: ${saveRequestId}`);
    console.log(`💾 User ID: ${userId}`);
    console.log(`💾 Items count: ${items ? items.length : 0}`);
    console.log(`💾 Raw items data:`, items);
    console.log(`💾 =========================================================\n`);
    
    // Validate input
    if (!items || !Array.isArray(items) || items.length === 0) {
      console.log(`❌ [${saveRequestId}] Invalid items data provided`);
      return res.status(400).json({
        success: false,
        error: 'No valid items provided to save',
        requestId: saveRequestId
      });
    }

    if (!userId || userId === 'anonymous') {
      console.log(`⚠️  [${saveRequestId}] No user ID provided, items will be saved as anonymous`);
    }
    
    // Prepare items for database insertion
    const itemsToSave = items.map((item, index) => {
      const dbItem = {
        user_id: userId,
        item_name: item.item || item.name,  // Handle both field names
        quantity: parseInt(item.quantity) || 1,
        expiration_date: item.expires || item.expiryDate,  // Handle both field names
        category: item.category || 'Other',  // Save category from AI analysis
        uploaded_at: new Date().toISOString(),
        created_at: new Date().toISOString()
      };
      
      console.log(`💾 [${saveRequestId}] Item ${index + 1} prepared:`, dbItem);
      return dbItem;
    });
    
    console.log(`💾 [${saveRequestId}] Attempting to save ${itemsToSave.length} items to Supabase...`);
    
    // Save to Supabase database with .select() to return inserted data
    const { data, error } = await supabase
      .from('fridge_items')
      .insert(itemsToSave)
      .select('*');  // This ensures inserted data is returned
    
    if (error) {
      console.error(`❌ [${saveRequestId}] Supabase error:`, error);
      throw error;
    }
    
    console.log(`✅ [${saveRequestId}] Successfully saved items to Supabase:`, data);
    console.log(`✅ [${saveRequestId}] Saved ${data ? data.length : 0} items`);
    
    res.json({
      success: true,
      message: `Successfully saved ${data ? data.length : items.length} items to your inventory`,
      savedItems: data,
      requestId: saveRequestId,
      userId: userId
    });
    
    console.log(`\n✅ [${saveRequestId}] =============== SAVE REQUEST COMPLETE ===============\n`);
    
  } catch (error) {
    console.error(`\n💥 [${saveRequestId}] ========== SAVE ERROR ==========`);
    console.error(`💥 [${saveRequestId}] Error saving items:`, error);
    console.error(`💥 [${saveRequestId}] Error message:`, error.message);
    console.error(`💥 [${saveRequestId}] Error details:`, error.details);
    console.error(`💥 [${saveRequestId}] Error hint:`, error.hint);
    console.error(`💥 [${saveRequestId}] ================================\n`);
    
    res.status(500).json({
      success: false,
      error: 'Failed to save items to database',
      errorDetails: error.message,
      requestId: saveRequestId
    });
  }
});

// Test endpoint
app.get('/api/test', (req, res) => {
  res.json({
    success: true,
    message: 'Backend is running!',
    timestamp: new Date().toISOString()
  });
});

// Import notification scheduler
const expiryNotificationScheduler = require('./services/expiryNotificationScheduler');

// Start server
app.listen(PORT, () => {
  const startupTime = new Date().toISOString();
  console.log(`\n🚀 =================================`);
  console.log(`🚀 SERVER STARTED: ${startupTime}`);
  console.log(`🚀 Port: ${PORT}`);
  console.log(`🚀 Node.js version: ${process.version}`);
  console.log(`🚀 =================================\n`);
  console.log(`Health check available at: http://localhost:${PORT}/api/health`);
  console.log(`Test endpoint available at: http://localhost:${PORT}/api/test`);
  console.log(`Auth endpoints available at: http://localhost:${PORT}/api/auth/`);
  console.log(`Image processing available at: http://localhost:${PORT}/api/process-images`);
  console.log(`\n📝 Environment check:`);
  console.log(`   FRONTEND_URL: ${process.env.FRONTEND_URL || 'Not set (using default)'}`);
  console.log(`   OPENROUTER_API_KEY: ${process.env.OPENROUTER_API_KEY ? '✅ Present' : '❌ Missing'}`);
  console.log(`   SUPABASE_URL: ${process.env.SUPABASE_URL ? '✅ Present' : '❌ Missing'}`);
  console.log(`   JWT_SECRET: ${process.env.JWT_SECRET ? '✅ Present' : '❌ Missing'}`);
  console.log(`   SPOONACULAR_API_KEY: ${process.env.SPOONACULAR_API_KEY ? '✅ Present' : '❌ Missing'}`);
  console.log(`   RAPIDAPI_KEY: ${process.env.RAPIDAPI_KEY ? '✅ Present (Instagram)' : '❌ Missing (Instagram)'}`);
  console.log(`   FIREWORKS_API_KEY: ${process.env.FIREWORKS_API_KEY ? '✅ Present' : '❌ Missing'}`);
  console.log(`   APIFY_API_TOKEN: ${process.env.APIFY_API_TOKEN ? '✅ Present' : '❌ Missing'}`);
  console.log(`   VAPID_PUBLIC_KEY: ${process.env.VAPID_PUBLIC_KEY ? '✅ Present' : '❌ Missing'}`);
  console.log(`   VAPID_PRIVATE_KEY: ${process.env.VAPID_PRIVATE_KEY ? '✅ Present' : '❌ Missing'}`);

  // Start the expiry notification scheduler
  console.log('\n🔔 Starting expiry notification scheduler...');
  expiryNotificationScheduler.start();
  console.log('🔔 Notification scheduler is running');
}); 