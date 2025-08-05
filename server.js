const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const { createClient } = require('@supabase/supabase-js');
const OpenAI = require('openai');
const multer = require('multer');

// Import authentication routes
const authRoutes = require('./routes/auth');

// Load environment variables
dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

// Configure multer for file uploads
const upload = multer({ 
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB limit
});

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Authentication routes
app.use('/api/auth', authRoutes);

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
            3. Estimated quantity 
            4. Estimated expiration date (see expiry logic below)
            
            TODAY'S DATE: ${new Date().toISOString().split('T')[0]}
            
            CATEGORIES - Choose the most appropriate category for each item:
            - Dairy (milk, cheese, yogurt, butter, cream, etc.)
            - Fruits (apples, bananas, dragon fruit, berries, citrus, etc.)
            - Vegetables (lettuce, carrots, tomatoes, peppers, onions, etc.)
            - Protein (meat, fish, eggs, beans, nuts, tofu, etc.)
            - Fats and oils (cooking oil, olive oil, avocado oil, coconut oil, etc.)
            - Grains (bread, rice, pasta, cereal, oats, quinoa, etc.)
            - Other (for items that don't fit the above categories)
            
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
              {"item": "Item Name", "category": "Fruits", "quantity": number, "expires": "YYYY-MM-DD"},
              {"item": "Item Name", "category": "Vegetables", "quantity": number, "expires": "YYYY-MM-DD"}
            ]
            
            Guidelines:
            - Use common grocery names (e.g., "Milk" not "Dairy beverage")
            - Be precise with categories (dragon fruit = "Fruits", not "Produce")
            - Quantity should be realistic (e.g., 1 for milk carton, 12 for egg carton, 6 for apple bag)
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
  console.log(`   OPENROUTER_API_KEY: ${process.env.OPENROUTER_API_KEY ? '✅ Present' : '❌ Missing'}`);
  console.log(`   SUPABASE_URL: ${process.env.SUPABASE_URL ? '✅ Present' : '❌ Missing'}`);
  console.log(`   JWT_SECRET: ${process.env.JWT_SECRET ? '✅ Present' : '❌ Missing'}`);
}); 