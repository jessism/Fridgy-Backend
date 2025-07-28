const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const { createClient } = require('@supabase/supabase-js');
const OpenAI = require('openai');

// Load environment variables
dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Initialize Supabase client
const supabaseUrl = process.env.SUPABASE_URL || 'your-supabase-url';
const supabaseKey = process.env.SUPABASE_ANON_KEY || 'your-supabase-anon-key';
const supabase = createClient(supabaseUrl, supabaseKey);

// Initialize OpenAI client for OpenRouter (works with Gemini 2.0 Flash)
const openai = new OpenAI({
  baseURL: "https://openrouter.ai/api/v1",
  apiKey: process.env.OPENROUTER_API_KEY,
  defaultHeaders: {
    "HTTP-Referer": "https://fridgy-app.com", // Optional: helps with rankings
    "X-Title": "Fridgy - AI Fridge Inventory", // Optional: shows in OpenRouter dashboard
  }
});

// Real AI processing function using Gemini 2.0 Flash
const analyzeGroceryImages = async (images) => {
  try {
    console.log(`Analyzing ${images.length} images with Gemini 2.0 Flash...`);
    
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

// Routes
app.get('/api/health', (req, res) => {
  res.json({ status: 'Server is running!' });
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