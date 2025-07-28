const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const { createClient } = require('@supabase/supabase-js');
const OpenAI = require('openai');

// Load environment variables
dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

// CORS configuration for production
const corsOptions = {
  origin: [
    'https://fridgy-frontend.vercel.app',
    'http://localhost:3000', // For local development
    'http://localhost:3001'  // Alternative local port
  ],
  credentials: true,
  optionsSuccessStatus: 200,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With']
};

// Middleware
app.use(cors(corsOptions));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Initialize Supabase client (with better error handling)
let supabase;
try {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_ANON_KEY;
  
  if (supabaseUrl && supabaseKey) {
    supabase = createClient(supabaseUrl, supabaseKey);
    console.log('✅ Supabase client initialized');
  } else {
    console.warn('⚠️ Supabase credentials missing - some features will be unavailable');
  }
} catch (error) {
  console.error('❌ Failed to initialize Supabase:', error.message);
}

// Initialize OpenAI client for OpenRouter (with better error handling)
let openai;
try {
  const openrouterKey = process.env.OPENROUTER_API_KEY;
  
  if (openrouterKey) {
    openai = new OpenAI({
      baseURL: "https://openrouter.ai/api/v1",
      apiKey: openrouterKey,
      defaultHeaders: {
        "HTTP-Referer": "https://fridgy-app.com", // Optional: helps with rankings
        "X-Title": "Fridgy - AI Fridge Inventory", // Optional: shows in OpenRouter dashboard
      }
    });
    console.log('✅ OpenAI client initialized');
  } else {
    console.warn('⚠️ OpenRouter API key missing - AI features will use mock data');
  }
} catch (error) {
  console.error('❌ Failed to initialize OpenAI:', error.message);
}

// Real AI processing function using Gemini 2.0 Flash
const analyzeGroceryImages = async (images) => {
  try {
    console.log(`Analyzing ${images.length} images with Gemini 2.0 Flash...`);
    
    // Check if OpenAI client is available
    if (!openai) {
      console.warn('OpenAI client not available, using mock data');
      const mockItems = [
        { item: "Milk", quantity: 1, expires: "2025-08-01" },
        { item: "Eggs", quantity: 12, expires: "2025-08-15" },
        { item: "Cheese", quantity: 1, expires: "2025-07-25" },
        { item: "Apples", quantity: 6, expires: "2025-08-10" }
      ];
      return mockItems.slice(0, Math.min(images.length + 1, mockItems.length));
    }
    
    // Prepare messages for Gemini 2.0 Flash
    const messages = [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: `Analyze these grocery/food images and identify each food item. For each item, provide:
            1. Item name (common grocery name)
            2. Estimated quantity 
            3. Estimated expiration date (be realistic based on typical shelf life)
            
            Return ONLY a JSON array in this exact format:
            [
              {"item": "Item Name", "quantity": number, "expires": "YYYY-MM-DD"},
              {"item": "Item Name", "quantity": number, "expires": "YYYY-MM-DD"}
            ]
            
            Guidelines:
            - Use common grocery names (e.g., "Milk" not "Dairy beverage")
            - Quantity should be realistic (e.g., 1 for milk carton, 12 for egg carton, 6 for apple bag)
            - Expiration dates should be realistic from today's date
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

    const completion = await openai.chat.completions.create({
      model: "google/gemini-2.0-flash-001",
      messages: messages,
      max_tokens: 1000,
      temperature: 0.1, // Low temperature for consistent results
    });

    const response = completion.choices[0].message.content;
    console.log("Gemini 2.0 Flash response:", response);
    
    // Parse JSON response
    try {
      const items = JSON.parse(response);
      return Array.isArray(items) ? items : [];
    } catch (parseError) {
      console.error("Error parsing AI response:", parseError);
      console.log("Raw response:", response);
      
      // Fallback: try to extract JSON from response
      const jsonMatch = response.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        return JSON.parse(jsonMatch[0]);
      }
      
      return [];
    }
    
  } catch (error) {
    console.error('Error with Gemini 2.0 Flash analysis:', error);
    
    // Fallback to mock data if AI fails
    const mockItems = [
      { item: "Milk", quantity: 1, expires: "2025-08-01" },
      { item: "Eggs", quantity: 12, expires: "2025-08-15" },
      { item: "Cheese", quantity: 1, expires: "2025-07-25" },
      { item: "Apples", quantity: 6, expires: "2025-08-10" }
    ];
    
    return mockItems.slice(0, Math.min(images.length + 1, mockItems.length));
  }
};

// Handle preflight requests
app.options('*', (req, res) => {
  res.header('Access-Control-Allow-Origin', req.headers.origin);
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
  res.header('Access-Control-Allow-Credentials', true);
  res.sendStatus(200);
});

// Routes
app.get('/api/health', (req, res) => {
  const healthStatus = {
    status: 'Server is running!',
    timestamp: new Date().toISOString(),
    port: PORT,
    services: {
      supabase: supabase ? 'connected' : 'disconnected',
      openai: openai ? 'connected' : 'disconnected'
    },
    environment: process.env.NODE_ENV || 'development'
  };
  
  console.log('Health check called:', healthStatus);
  res.json(healthStatus);
});

// Process uploaded images and return AI analysis
app.post('/api/analyze-images', async (req, res) => {
  try {
    const { imageCount, images } = req.body;
    
    console.log(`Processing request with imageCount: ${imageCount}, images: ${images?.length || 0}`);
    
    let analysisResults;
    
    if (images && images.length > 0) {
      // Use real AI analysis with Gemini 2.0 Flash
      console.log('Using Gemini 2.0 Flash for real AI analysis...');
      analysisResults = await analyzeGroceryImages(images);
    } else {
      // Fallback: Use mock data based on imageCount (for backward compatibility)
      console.log('No images provided, using mock data...');
      const mockItems = [
        { item: "Milk", quantity: 1, expires: "2025-08-01" },
        { item: "Eggs", quantity: 12, expires: "2025-08-15" },
        { item: "Cheese", quantity: 1, expires: "2025-07-25" },
        { item: "Apples", quantity: 6, expires: "2025-08-10" }
      ];
      analysisResults = mockItems.slice(0, Math.min(imageCount + 1, mockItems.length));
    }
    
    res.json({
      success: true,
      items: analysisResults,
      aiUsed: images && images.length > 0 ? 'gemini-2.0-flash' : 'mock'
    });
  } catch (error) {
    console.error('Error analyzing images:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to analyze images'
    });
  }
});

// Save confirmed items to Supabase database
app.post('/api/save-items', async (req, res) => {
  try {
    const { items, userId = 'anonymous' } = req.body;
    
    console.log('Saving items to database:', items);
    
    // Check if Supabase is available
    if (!supabase) {
      console.warn('Supabase not available, returning mock success');
      return res.json({
        success: true,
        message: `Mock saved ${items.length} items (Supabase not configured)`,
        savedItems: items
      });
    }
    
    // Prepare items for database insertion
    const itemsToSave = items.map(item => ({
      user_id: userId,
      item_name: item.item,
      quantity: item.quantity,
      expiration_date: item.expires,
      uploaded_at: new Date().toISOString()
    }));
    
    // Save to Supabase database
    const { data, error } = await supabase
      .from('fridge_items')
      .insert(itemsToSave);
    
    if (error) {
      throw error;
    }
    
    console.log('Successfully saved items to Supabase:', data);
    
    res.json({
      success: true,
      message: `Successfully saved ${items.length} items to database`,
      savedItems: data
    });
  } catch (error) {
    console.error('Error saving items:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to save items to database'
    });
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
  console.log(`Health check available at: http://localhost:${PORT}/api/health`);
}); 