const fetch = require('node-fetch');

class RecipeAIExtractor {
  constructor() {
    this.apiKey = process.env.OPENROUTER_API_KEY;
    // Use standard Gemini Flash model that's widely available
    this.model = 'google/gemini-flash-1.5';
  }

  async extractFromInstagramData(instagramData) {
    console.log('[RecipeAIExtractor] Starting extraction with data:', {
      hasCaption: !!instagramData.caption,
      captionLength: instagramData.caption?.length || 0,
      captionPreview: instagramData.caption?.substring(0, 100),
      hashtagCount: instagramData.hashtags?.length || 0,
      imageCount: instagramData.images?.length || 0
    });
    
    const prompt = this.buildPrompt(instagramData);
    
    try {
      // If no API key configured, return mock data for testing
      if (!this.apiKey) {
        console.log('[RecipeAIExtractor] No API key configured, returning mock data');
        return this.getMockRecipe(instagramData);
      }

      const response = await this.callAI(prompt, instagramData.images);
      let result;
      
      try {
        result = JSON.parse(response);
        console.log('[RecipeAIExtractor] AI extraction result:', {
          success: result.success,
          confidence: result.confidence,
          hasRecipe: !!result.recipe,
          title: result.recipe?.title,
          ingredientCount: result.recipe?.extendedIngredients?.length,
          stepCount: result.recipe?.analyzedInstructions?.[0]?.steps?.length
        });
      } catch (parseError) {
        console.error('[RecipeAIExtractor] Failed to parse AI response:', parseError);
        console.log('[RecipeAIExtractor] Raw AI response:', response);
        throw new Error('Invalid AI response format');
      }
      
      // Validate and clean the result
      const finalResult = this.validateAndTransformRecipe(result);
      
      console.log('[RecipeAIExtractor] Final extraction result:', {
        success: finalResult.success,
        confidence: finalResult.confidence,
        title: finalResult.recipe?.title
      });
      
      return finalResult;
    } catch (error) {
      console.error('[RecipeAIExtractor] AI extraction error:', error);
      return this.getErrorResponse(error.message);
    }
  }

  buildPrompt(data) {
    return `You are a professional recipe extractor. Analyze this Instagram post and extract a complete recipe.

POST CONTENT:
Caption: ${data.caption || 'No caption provided'}
Hashtags: ${data.hashtags?.join(', ') || 'None'}
Author: @${data.author?.username || 'unknown'}
Has ${data.images?.length || 0} image(s)
${data.videos?.length ? `Has video (${data.videos[0].duration}s)` : ''}

IMPORTANT: Instagram recipes are often informal. Be FLEXIBLE and extract whatever recipe information is available, even if incomplete.

EXTRACTION RULES:
1. Look for recipe content ANYWHERE in the caption - it might be mixed with other text
2. Common Instagram recipe patterns to look for:
   - "INGREDIENTS:" or "What you need:" or emoji-based lists (•, -, ✓)
   - "INSTRUCTIONS:" or "How to:" or numbered/bulleted steps
   - Ingredients might be inline: "I used 2 cups flour and 1 cup sugar"
   - Instructions might be narrative: "First I mixed... then I baked..."
3. If amounts aren't specified, make reasonable estimates based on the dish type
4. If instructions are vague, break them into logical cooking steps
5. Extract partial recipes - better to get some info than none
6. Look for recipe clues in hashtags (#recipe #baking #dinner etc)

RETURN THIS EXACT JSON FORMAT:
{
  "success": true,
  "confidence": 0.0-1.0,
  "recipe": {
    "title": "Recipe name",
    "summary": "A brief 1-2 sentence description of the dish",
    "image": "URL of main image",
    
    "extendedIngredients": [
      {
        "id": 1,
        "amount": 2,
        "unit": "pounds",
        "name": "chicken breast",
        "original": "2 pounds boneless chicken breast",
        "meta": ["boneless"]
      }
    ],
    
    "analyzedInstructions": [
      {
        "name": "",
        "steps": [
          {
            "number": 1,
            "step": "First step description here"
          },
          {
            "number": 2,
            "step": "Second step description here"
          }
        ]
      }
    ],
    
    "readyInMinutes": 30,
    "cookingMinutes": 20,
    "servings": 4,
    
    "vegetarian": false,
    "vegan": false,
    "glutenFree": false,
    "dairyFree": false,
    "veryHealthy": false,
    "cheap": false,
    "veryPopular": false,
    
    "cuisines": ["Italian"],
    "dishTypes": ["main course", "dinner"],
    "diets": [],
    
    "nutrition": null
  },
  "extractionNotes": "Any issues or notes about extraction",
  "missingInfo": ["list", "of", "missing", "elements"],
  "requiresUserInput": false
}

IMPORTANT FORMATTING RULES:
- extendedIngredients MUST have: id, amount (number), unit, name, original (full text), meta (array)
- analyzedInstructions MUST have: name (empty string), steps array with number and step fields
- All boolean dietary fields must be included
- nutrition should always be null (we'll calculate later)
- ALWAYS try to extract SOMETHING - even if it's just a title and basic ingredients
- Only set success: false if there's ABSOLUTELY NO recipe content at all
- Be creative in parsing informal recipe formats - Instagram posts are rarely formal recipes`;
  }

  async callAI(prompt, images = []) {
    const messages = [{
      role: 'user',
      content: [
        { type: 'text', text: prompt },
        ...images.slice(0, 5).map(img => ({
          type: 'image_url',
          image_url: { url: img.url || img }
        }))
      ]
    }];

    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://fridgy.app',
        'X-Title': 'Fridgy Recipe Import'
      },
      body: JSON.stringify({
        model: this.model,
        messages,
        response_format: { type: 'json_object' },
        temperature: 0.3,
        max_tokens: 2000
      })
    });

    const data = await response.json();
    
    if (!response.ok) {
      throw new Error(data.error?.message || 'AI API error');
    }
    
    return data.choices[0].message.content;
  }

  validateAndTransformRecipe(result) {
    // Ensure required fields exist
    if (!result.recipe) {
      result.recipe = {};
      result.success = false;
      result.requiresUserInput = true;
    }

    const recipe = result.recipe;
    
    // Ensure extendedIngredients format matches RecipeDetailModal
    if (!recipe.extendedIngredients || !Array.isArray(recipe.extendedIngredients)) {
      recipe.extendedIngredients = [];
    } else {
      // Ensure each ingredient has required fields
      recipe.extendedIngredients = recipe.extendedIngredients.map((ing, index) => ({
        id: ing.id || index + 1,
        amount: typeof ing.amount === 'number' ? ing.amount : parseFloat(ing.amount) || 1,
        unit: ing.unit || '',
        name: ing.name || 'ingredient',
        original: ing.original || `${ing.amount || ''} ${ing.unit || ''} ${ing.name || ''}`.trim(),
        meta: ing.meta || []
      }));
    }

    // Ensure analyzedInstructions format matches RecipeDetailModal
    if (!recipe.analyzedInstructions || !Array.isArray(recipe.analyzedInstructions)) {
      recipe.analyzedInstructions = [{
        name: '',
        steps: []
      }];
    } else if (recipe.analyzedInstructions.length > 0) {
      // Ensure steps have required format
      recipe.analyzedInstructions[0].steps = (recipe.analyzedInstructions[0].steps || []).map((step, index) => ({
        number: step.number || index + 1,
        step: step.step || ''
      }));
    }

    // Set defaults for required fields
    recipe.title = recipe.title || 'Untitled Recipe';
    recipe.summary = recipe.summary || 'A delicious recipe from Instagram';
    recipe.readyInMinutes = recipe.readyInMinutes || 30;
    recipe.cookingMinutes = recipe.cookingMinutes || recipe.readyInMinutes;
    recipe.servings = recipe.servings || 4;
    
    // Ensure all dietary booleans exist
    recipe.vegetarian = recipe.vegetarian || false;
    recipe.vegan = recipe.vegan || false;
    recipe.glutenFree = recipe.glutenFree || false;
    recipe.dairyFree = recipe.dairyFree || false;
    recipe.veryHealthy = recipe.veryHealthy || false;
    recipe.cheap = recipe.cheap || false;
    recipe.veryPopular = recipe.veryPopular || false;
    
    // Ensure arrays exist
    recipe.cuisines = recipe.cuisines || [];
    recipe.dishTypes = recipe.dishTypes || [];
    recipe.diets = recipe.diets || [];
    
    // Nutrition is always null for imported recipes
    recipe.nutrition = null;
    
    // Calculate confidence based on completeness (more lenient)
    let confidence = 1.0;
    if (!recipe.title || recipe.title === 'Untitled Recipe') confidence -= 0.2;
    if (recipe.extendedIngredients.length === 0) confidence -= 0.25;
    if (!recipe.analyzedInstructions || 
        !recipe.analyzedInstructions[0] || 
        !recipe.analyzedInstructions[0].steps || 
        recipe.analyzedInstructions[0].steps.length === 0) confidence -= 0.25;
    
    result.confidence = Math.max(0.1, confidence); // Minimum 10% confidence
    // Much more lenient - accept anything with at least title OR ingredients OR instructions
    result.success = (recipe.title && recipe.title !== 'Untitled Recipe') || 
                     recipe.extendedIngredients.length > 0 || 
                     (recipe.analyzedInstructions?.[0]?.steps?.length > 0);
    
    return result;
  }

  getErrorResponse(errorMessage) {
    // Try to return a partial recipe even on error
    return {
      success: false,
      confidence: 0,
      recipe: {
        title: "Recipe from Instagram",
        summary: "Unable to extract complete recipe details. Please review and edit.",
        image: 'https://images.unsplash.com/photo-1546069901-ba9599a7e63c',
        extendedIngredients: [],
        analyzedInstructions: [{
          name: '',
          steps: []
        }],
        readyInMinutes: 30,
        cookingMinutes: 30,
        servings: 4,
        vegetarian: false,
        vegan: false,
        glutenFree: false,
        dairyFree: false,
        veryHealthy: false,
        cheap: false,
        veryPopular: false,
        cuisines: [],
        dishTypes: [],
        diets: [],
        nutrition: null
      },
      extractionNotes: `Extraction incomplete: ${errorMessage}. The post may not contain a complete recipe or the format is not recognized.`,
      missingInfo: ['ingredients', 'instructions'],
      requiresUserInput: true,
      partialExtraction: true
    };
  }

  // Mock recipe for testing without AI API
  getMockRecipe(instagramData) {
    const mockRecipe = {
      success: true,
      confidence: 0.95,
      recipe: {
        title: "Creamy Garlic Parmesan Pasta",
        summary: "A rich and creamy pasta dish with garlic and Parmesan cheese, perfect for a quick weeknight dinner.",
        image: instagramData.images?.[0]?.url || 'https://images.unsplash.com/photo-1546069901-ba9599a7e63c',
        
        extendedIngredients: [
          {
            id: 1,
            amount: 1,
            unit: "pound",
            name: "fettuccine pasta",
            original: "1 pound fettuccine pasta",
            meta: []
          },
          {
            id: 2,
            amount: 4,
            unit: "cloves",
            name: "garlic",
            original: "4 cloves garlic, minced",
            meta: ["minced"]
          },
          {
            id: 3,
            amount: 1,
            unit: "cup",
            name: "heavy cream",
            original: "1 cup heavy cream",
            meta: []
          },
          {
            id: 4,
            amount: 1,
            unit: "cup",
            name: "Parmesan cheese",
            original: "1 cup freshly grated Parmesan cheese",
            meta: ["freshly grated"]
          },
          {
            id: 5,
            amount: 2,
            unit: "tablespoons",
            name: "butter",
            original: "2 tablespoons butter",
            meta: []
          },
          {
            id: 6,
            amount: 2,
            unit: "tablespoons",
            name: "olive oil",
            original: "2 tablespoons olive oil",
            meta: []
          },
          {
            id: 7,
            amount: 1,
            unit: "serving",
            name: "salt and pepper",
            original: "Salt and pepper to taste",
            meta: ["to taste"]
          },
          {
            id: 8,
            amount: 1,
            unit: "serving",
            name: "fresh parsley",
            original: "Fresh parsley for garnish",
            meta: ["fresh", "for garnish"]
          }
        ],
        
        analyzedInstructions: [
          {
            name: "",
            steps: [
              {
                number: 1,
                step: "Cook pasta according to package directions until al dente. Reserve 1 cup pasta water before draining."
              },
              {
                number: 2,
                step: "In a large skillet, melt butter with olive oil over medium heat."
              },
              {
                number: 3,
                step: "Add minced garlic and sauté for 1 minute until fragrant."
              },
              {
                number: 4,
                step: "Pour in heavy cream and bring to a gentle simmer."
              },
              {
                number: 5,
                step: "Add Parmesan cheese and stir until melted and smooth."
              },
              {
                number: 6,
                step: "Add cooked pasta to the sauce and toss to combine."
              },
              {
                number: 7,
                step: "Add pasta water as needed to reach desired consistency."
              },
              {
                number: 8,
                step: "Season with salt and pepper to taste."
              },
              {
                number: 9,
                step: "Garnish with fresh parsley and extra Parmesan cheese before serving."
              }
            ]
          }
        ],
        
        readyInMinutes: 20,
        cookingMinutes: 20,
        servings: 4,
        
        vegetarian: true,
        vegan: false,
        glutenFree: false,
        dairyFree: false,
        veryHealthy: false,
        cheap: true,
        veryPopular: true,
        
        cuisines: ["Italian"],
        dishTypes: ["main course", "dinner"],
        diets: ["vegetarian"],
        
        nutrition: null
      },
      extractionNotes: "Successfully extracted recipe from Instagram post (mock data for testing)",
      missingInfo: [],
      requiresUserInput: false
    };

    // If there's actual caption data, try to parse it
    if (instagramData.caption && instagramData.caption.toLowerCase().includes('ingredient')) {
      // Simple parsing logic for testing
      const lines = instagramData.caption.split('\n');
      const title = lines.find(line => line.length > 5 && !line.includes('INGREDIENT') && !line.includes('#'))?.trim();
      if (title) {
        mockRecipe.recipe.title = title.replace(/[🍝🌟✨]/g, '').trim();
      }
    }

    return mockRecipe;
  }
}

module.exports = RecipeAIExtractor;