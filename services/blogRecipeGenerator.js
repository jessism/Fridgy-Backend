const fetch = require('node-fetch');
const sharp = require('sharp');
const { getServiceClient } = require('../config/supabase');

class BlogRecipeGenerator {
  constructor() {
    this.apiKey = process.env.OPENROUTER_API_KEY;
    this.model = 'google/gemini-2.5-flash';
  }

  /**
   * Upload a photo to Supabase Storage, compress it first
   * @param {Buffer} imageBuffer - Raw image buffer from multer
   * @param {string} mimetype - Original mimetype
   * @returns {string} Public URL of the uploaded image
   */
  async uploadImage(imageBuffer, mimetype) {
    const supabase = getServiceClient();

    // Compress and resize to 1200px wide, JPEG 80% quality
    const compressed = await sharp(imageBuffer)
      .resize(1200, null, { withoutEnlargement: true })
      .jpeg({ quality: 80 })
      .toBuffer();

    const timestamp = Date.now();
    const randomId = Math.random().toString(36).substring(2, 8);
    const fileName = `blog_${timestamp}_${randomId}.jpg`;

    const { data, error } = await supabase.storage
      .from('blog-recipe-images')
      .upload(fileName, compressed, {
        contentType: 'image/jpeg',
        upsert: false
      });

    if (error) {
      console.error('[BlogRecipe] Storage upload error:', error.message);
      throw new Error('Failed to upload image');
    }

    const { data: urlData } = supabase.storage
      .from('blog-recipe-images')
      .getPublicUrl(fileName);

    console.log('[BlogRecipe] Image uploaded:', urlData.publicUrl);
    return urlData.publicUrl;
  }

  /**
   * Generate a recipe from a food photo using Gemini
   * @param {string} base64Image - Base64 encoded image with data URI prefix
   * @returns {object} Generated recipe data
   */
  async generateRecipe(base64Image) {
    if (!this.apiKey) {
      throw new Error('OPENROUTER_API_KEY is not configured');
    }

    const messages = [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: `You are an expert chef and recipe writer. Look at this photo of a dish and create a detailed, realistic recipe for it.

IMPORTANT RULES:
- Identify the EXACT dish in the photo. Be specific (e.g., "Pan-Seared Salmon with Lemon Butter Sauce" not just "Salmon").
- The recipe MUST be realistic and actually cookable by a home cook.
- Use SPECIFIC measurements (e.g., "2 tablespoons" not "some").
- Use SPECIFIC temperatures (e.g., "375°F / 190°C").
- Use SPECIFIC timings (e.g., "cook for 6-8 minutes" not "cook until done").
- Include 8-15 ingredients with exact amounts.
- Include 4-8 clear instruction steps. Each step should be 1-3 sentences.
- Add practical tips where helpful (e.g., "pat the chicken dry for a better sear").
- The description should be 1-2 sentences, appealing and SEO-friendly.
- Generate relevant tags for categorization.

Respond with ONLY valid JSON in this exact format:
{
  "title": "Dish Name",
  "description": "A brief, appetizing description of the dish.",
  "prep_time": "15 mins",
  "cook_time": "25 mins",
  "servings": 4,
  "ingredients": [
    "2 lbs chicken thighs, bone-in and skin-on",
    "3 tablespoons olive oil"
  ],
  "instructions": [
    "Preheat oven to 400°F (200°C). Pat chicken thighs dry with paper towels and season generously with salt and pepper.",
    "Heat olive oil in a large oven-safe skillet over medium-high heat. Place chicken skin-side down and sear for 5-6 minutes until the skin is golden and crispy."
  ],
  "tags": ["chicken", "dinner", "easy"]
}`
          },
          {
            type: "image_url",
            image_url: {
              url: base64Image
            }
          }
        ]
      }
    ];

    const requestBody = {
      model: this.model,
      messages: messages,
      max_tokens: 2000,
      temperature: 0.3
    };

    console.log('[BlogRecipe] Calling OpenRouter for recipe generation...');
    const startTime = Date.now();

    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://trackabite.app',
        'X-Title': 'Trackabite Blog Recipe Generator'
      },
      body: JSON.stringify(requestBody)
    });

    const duration = Date.now() - startTime;
    console.log(`[BlogRecipe] OpenRouter responded in ${duration}ms, status: ${response.status}`);

    if (!response.ok) {
      const errorText = await response.text();
      console.error('[BlogRecipe] OpenRouter error:', errorText);
      throw new Error(`AI API error: ${response.status} - ${errorText}`);
    }

    const completion = await response.json();

    if (!completion.choices || completion.choices.length === 0) {
      throw new Error('No response from AI');
    }

    const content = completion.choices[0].message.content;

    // Parse JSON from response (handle markdown code blocks)
    let recipe;
    try {
      const jsonStr = content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      recipe = JSON.parse(jsonStr);
    } catch (parseError) {
      console.error('[BlogRecipe] Failed to parse AI response:', content);
      throw new Error('AI returned invalid recipe format. Try again.');
    }

    // Validate required fields
    const required = ['title', 'description', 'prep_time', 'cook_time', 'servings', 'ingredients', 'instructions'];
    for (const field of required) {
      if (!recipe[field]) {
        throw new Error(`AI recipe missing required field: ${field}`);
      }
    }

    // Generate slug from title
    recipe.slug = this.slugify(recipe.title);
    recipe.tags = recipe.tags || [];

    return recipe;
  }

  /**
   * Convert title to URL-friendly slug
   */
  slugify(text) {
    return text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
  }

  /**
   * Ensure slug is unique by appending -2, -3, etc. if needed
   * @param {string} slug - Base slug
   * @returns {string} Unique slug
   */
  async ensureUniqueSlug(slug) {
    const supabase = getServiceClient();

    const { data: existing } = await supabase
      .from('blog_recipes')
      .select('slug')
      .like('slug', `${slug}%`);

    if (!existing || existing.length === 0) {
      return slug;
    }

    const existingSlugs = new Set(existing.map(r => r.slug));

    if (!existingSlugs.has(slug)) {
      return slug;
    }

    let counter = 2;
    while (existingSlugs.has(`${slug}-${counter}`)) {
      counter++;
    }

    return `${slug}-${counter}`;
  }
}

module.exports = new BlogRecipeGenerator();
