const { createClient } = require('@supabase/supabase-js');
const { GoogleGenAI } = require('@google/genai');
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

// Image Generation Service — Gemini (primary) with OpenRouter fallback
class ImageGenerationService {
  constructor() {
    // Gemini (primary)
    this.geminiModel = 'gemini-3.1-flash-image';
    // OpenRouter (fallback)
    this.fallbackModel = 'openai/gpt-image-1-mini';
    this.defaultCost = 0.005;
  }

  // Build Gemini prompt — ported from TikTok carousel automation (Nano Banana)
  buildGeminiImagePrompt(recipeTitle, keyIngredients, cuisineType = '') {
    const ingredientsList = keyIngredients.join(', ');
    const cuisineContext = cuisineType ? ` (${cuisineType} cuisine)` : '';
    const slideDescription = `A beautifully plated dish of ${recipeTitle}, made with ${ingredientsList}${cuisineContext}. Show the finished dish ready to eat.`;

    return `Generate a vertical 9:16 photo for a food app.

STYLE — professional editorial food photography that looks premium but believable:
- Tight close-up shot — food fills at least 90% of the frame, almost no background visible
- Shot on Canon R5 with 85mm lens, very shallow depth of field (f/1.8), background completely blurred out
- Natural window light from one side, subtle shadows — not uniformly lit
- Background is just a soft blur of color — no distracting objects, props, or kitchen items
- Slightly off-center framing — not perfectly symmetrical
- The plate/container edges can be partially cropped, but the plate geometry must be realistic
- Food should look homemade and delicious but NOT hyperperfect:
  - Realistic food textures (visible muscle fibers on meat, natural grain)
  - Slightly uneven portions, cuts, and slices
  - Vegetables with natural variation in size and ripeness
  - A few grains or crumbs scattered naturally
- Glass or ceramic containers/plates — realistic, not brand new
- Authentic home-cooked appearance — premium but believable, not CGI, not stock photo

STRICT RULES:
- ABSOLUTELY NO text, words, letters, numbers, labels, or watermarks anywhere in the image
- NO human faces, NO hands, NO human body parts
- NO wooden utensils — if any utensils are visible, they must be METAL only
- NO background props, towels, jars, or kitchen items — only the food and its container
- NO overly styled or cluttered background — keep focus extremely tight on the food

AVOID these AI giveaways:
- Perfect symmetry or mathematical arrangement of food
- Every ingredient identical in size, color, and placement
- Unnaturally smooth meat textures with no fibers
- Spotless containers with zero food residue
- Uniform lighting with no shadows
- Overly saturated colors that look like a 3D render
- Wide shots showing too much background, props, towels, or kitchen items
- Plates or bowls with impossible geometry

DISH TO PHOTOGRAPH:
${slideDescription}

CRITICAL REMINDER: Generate a PHOTOGRAPH ONLY. Do NOT render ANY text, labels, titles, captions, dish names, or words of any kind in the image. The dish names in the description are for context only — do NOT write them on the image. The output must be a pure food photograph with ZERO text.`;
  }

  // Generate image using Gemini (Nano Banana) — primary provider
  async generateImageWithGemini(recipeTitle, keyIngredients, cuisineType = '') {
    const requestId = Math.random().toString(36).substring(7);

    console.log(`\n🍌 [${requestId}] ===== GEMINI (Nano Banana) IMAGE GENERATION =====`);
    console.log(`🍌 [${requestId}] Recipe: ${recipeTitle}`);
    console.log(`🍌 [${requestId}] Model: ${this.geminiModel}`);

    if (!process.env.GEMINI_IMAGE_API_KEY) {
      throw new Error('GEMINI_IMAGE_API_KEY is missing from environment variables');
    }

    const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_IMAGE_API_KEY });
    const prompt = this.buildGeminiImagePrompt(recipeTitle, keyIngredients, cuisineType);

    console.log(`📝 [${requestId}] Prompt length: ${prompt.length} chars`);

    const response = await ai.models.generateContent({
      model: this.geminiModel,
      contents: prompt,
      config: { responseModalities: ['IMAGE'] },
    });

    // Extract image data from response
    for (const part of response.candidates[0].content.parts) {
      if (part.inlineData && part.inlineData.mimeType.startsWith('image/')) {
        const base64Image = part.inlineData.data;
        console.log(`✅ [${requestId}] Gemini image generated, base64 length: ${base64Image.length}`);
        return `data:image/jpeg;base64,${base64Image}`;
      }
    }

    throw new Error('No image returned from Gemini API');
  }

  // Generate recipe hash for image caching
  generateRecipeHash(recipeTitle, keyIngredients) {
    // Use recipe title as primary identifier, ingredients as secondary
    // Keep more details for uniqueness but normalize consistently
    const hashContent = {
      title: recipeTitle.toLowerCase().trim().replace(/\s+/g, ' '), // Normalize whitespace but keep words
      ingredients: keyIngredients.sort().join('|').toLowerCase(), // Sort for consistency
      titleLength: recipeTitle.length, // Add length as differentiator
      wordCount: recipeTitle.split(/\s+/).length // Add word count for uniqueness
    };
    
    return crypto
      .createHash('sha256')
      .update(JSON.stringify(hashContent))
      .digest('hex')
      .substring(0, 24); // Even longer hash for better uniqueness
  }

  // Upload base64 image to Supabase Storage (following Instagram pattern)
  async uploadImageToSupabase(base64Data, recipeHash, userId) {
    const requestId = Math.random().toString(36).substring(7);

    try {
      console.log(`📤 [${requestId}] Uploading AI recipe image to Supabase...`);

      // Remove data URL prefix if present
      const base64String = base64Data.includes(',')
        ? base64Data.split(',')[1]
        : base64Data;

      // Convert base64 to buffer
      const imageBuffer = Buffer.from(base64String, 'base64');
      console.log(`📊 [${requestId}] Image buffer size: ${imageBuffer.length} bytes`);

      // Check file size (limit to 10MB)
      const maxSizeBytes = 10 * 1024 * 1024;
      if (imageBuffer.length > maxSizeBytes) {
        console.error(`❌ [${requestId}] Image too large: ${imageBuffer.length} bytes`);
        throw new Error('Image file too large (max 10MB)');
      }

      // Generate unique filename
      const timestamp = Date.now();
      const fileName = `${userId}/ai-recipe-${recipeHash}-${timestamp}.jpg`;
      console.log(`📝 [${requestId}] Uploading to: recipe-images/${fileName}`);

      // Upload to Supabase storage (same bucket as imported recipes)
      const supabase = getSupabaseClient();
      const { data: uploadData, error: uploadError } = await supabase.storage
        .from('recipe-images')
        .upload(fileName, imageBuffer, {
          contentType: 'image/jpeg',
          cacheControl: '31536000', // 1 year cache
          upsert: false
        });

      if (uploadError) {
        console.error(`❌ [${requestId}] Supabase upload error:`, uploadError);
        throw uploadError;
      }

      // Get public URL
      const { data: urlData } = supabase.storage
        .from('recipe-images')
        .getPublicUrl(fileName);

      if (!urlData || !urlData.publicUrl) {
        throw new Error('Failed to get public URL');
      }

      console.log(`✅ [${requestId}] Image uploaded successfully: ${urlData.publicUrl}`);
      return urlData.publicUrl;

    } catch (error) {
      console.error(`❌ [${requestId}] Error uploading image to Supabase:`, error.message);
      throw error;
    }
  }

  // Build GPT-optimized prompt for food photography (used by OpenRouter fallback)
  buildGPTImagePrompt(recipeTitle, keyIngredients, cuisineType = '') {
    const ingredientsList = keyIngredients.join(', ');
    const cuisineContext = cuisineType ? ` (${cuisineType} cuisine)` : '';

    return `Photograph a real homemade dish of ${recipeTitle}, made with ${ingredientsList}${cuisineContext}.

This must look like a casual photo taken by someone at home with their phone — NOT a professional studio shot. Think "posted on Instagram by a home cook", not "food magazine cover".

CAMERA: Slightly angled (about 30-45 degrees), not perfectly overhead. Natural window light from one side creating soft shadows. Shallow depth of field — background should be blurry.

FOOD: The dish should look freshly cooked and imperfect:
- Slightly uneven portions, a drip of sauce on the plate rim
- Natural color variation in vegetables — not every piece identical
- Visible texture on meat (muscle fibers, sear marks with slight char)
- A few crumbs or grains scattered naturally around the plate
- Steam or warmth implied through slight gloss on the food

PLATE/SETTING: Simple ceramic plate or bowl, slightly off-center in frame. No props, no garnish towers, no napkins, no background objects. Just food on a plate, tight crop.

DO NOT include: any text, labels, watermarks, human hands, wooden utensils, multiple dishes, garnish that looks decoratively placed, perfectly symmetrical food arrangement, unnaturally vibrant colors, or any element that makes this look AI-generated or styled by a food photographer.`;
  }

  // Check if we have a cached image for this recipe
  async getCachedImage(recipeHash) {
    const requestId = Math.random().toString(36).substring(7);
    
    try {
      console.log(`🖼️  [${requestId}] Checking image cache for recipe hash: ${recipeHash}`);
      
      const supabase = getSupabaseClient();
      const { data, error } = await supabase
        .from('ai_recipe_images')
        .select('*')
        .eq('recipe_hash', recipeHash)
        .single();

      if (error && error.code !== 'PGRST116') {
        console.log(`⚠️  [${requestId}] Image cache check error (non-critical):`, error.message);
        return null;
      }

      if (data) {
        console.log(`✅ [${requestId}] Image cache hit! Found image: ${data.image_url.substring(0, 50)}...`);
        return data.image_url;
      }

      console.log(`🚫 [${requestId}] No cached image found for recipe`);
      return null;

    } catch (error) {
      console.error(`❌ [${requestId}] Image cache check failed:`, error);
      return null; // Don't fail image generation if cache check fails
    }
  }

  // Generate image using OpenRouter GPT Image 1 Mini (fallback provider)
  async generateImageWithOpenRouter(recipeTitle, keyIngredients, cuisineType = '') {
    const requestId = Math.random().toString(36).substring(7);

    console.log(`\n🖼️ [${requestId}] ===== OPENROUTER (fallback) IMAGE GENERATION =====`);
    console.log(`🖼️ [${requestId}] Recipe: ${recipeTitle}`);
    console.log(`🖼️ [${requestId}] Model: ${this.fallbackModel}`);

    if (!process.env.OPENROUTER_API_KEY) {
      throw new Error('OPENROUTER_API_KEY is missing from environment variables');
    }

    const prompt = this.buildGPTImagePrompt(recipeTitle, keyIngredients, cuisineType);

    const response = await fetch('https://openrouter.ai/api/v1/images', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://fridgy.app',
        'X-Title': 'Fridgy AI Recipe Images'
      },
      body: JSON.stringify({
        model: this.fallbackModel,
        prompt: prompt,
        n: 1,
        response_format: 'b64_json',
        size: '1024x1024'
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`OpenRouter API error: ${response.status} ${response.statusText} - ${errorText}`);
    }

    const result = await response.json();
    if (!result || !result.data || result.data.length === 0) {
      throw new Error('No images returned from OpenRouter API');
    }

    const base64Image = result.data[0].b64_json;
    if (!base64Image) throw new Error('No image data returned from OpenRouter API');

    console.log(`✅ [${requestId}] OpenRouter image generated, base64 length: ${base64Image.length}`);
    return `data:image/jpeg;base64,${base64Image}`;
  }

  // Generate image — tries Gemini first, falls back to OpenRouter
  async generateImage(recipeTitle, keyIngredients, cuisineType = '', userId = null) {
    const requestId = Math.random().toString(36).substring(7);
    let imageUrl;
    let provider;

    console.log(`\n🎨 =============== IMAGE GENERATION START ===============`);
    console.log(`🎨 REQUEST ID: ${requestId}`);
    console.log(`🎨 Recipe: ${recipeTitle}`);
    console.log(`🎨 Timestamp: ${new Date().toISOString()}`);
    console.log(`🎨 ======================================================\n`);

    // Try OpenRouter first (testing GPT image quality)
    try {
      imageUrl = await this.generateImageWithOpenRouter(recipeTitle, keyIngredients, cuisineType);
      provider = 'OpenRouter';
    } catch (openRouterError) {
      console.warn(`⚠️ [${requestId}] OpenRouter failed: ${openRouterError.message}`);
      console.warn(`⚠️ [${requestId}] Falling back to Gemini...`);

      // Try Gemini as fallback
      try {
        imageUrl = await this.generateImageWithGemini(recipeTitle, keyIngredients, cuisineType);
        provider = 'Gemini';
      } catch (geminiError) {
        console.error(`💥 [${requestId}] Both providers failed`);
        console.error(`💥 [${requestId}] OpenRouter: ${openRouterError.message}`);
        console.error(`💥 [${requestId}] Gemini: ${geminiError.message}`);
        throw new Error(`Image generation failed — OpenRouter: ${openRouterError.message} | Gemini: ${geminiError.message}`);
      }
    }

    console.log(`✅ [${requestId}] Image generated via ${provider}`);

    // Upload to Supabase Storage
    if (userId) {
      const recipeHash = this.generateRecipeHash(recipeTitle, keyIngredients);
      const permanentUrl = await this.uploadImageToSupabase(imageUrl, recipeHash, userId);
      console.log(`✅ [${requestId}] Permanent URL: ${permanentUrl}`);
      return permanentUrl;
    } else {
      console.warn(`⚠️ [${requestId}] No userId provided, returning base64`);
      return imageUrl;
    }
  }

  // Cache generated image for future use
  async cacheImage(recipeHash, imageUrl, promptUsed) {
    const requestId = Math.random().toString(36).substring(7);
    
    try {
      console.log(`💾 [${requestId}] Caching image for hash: ${recipeHash}`);
      
      const supabase = getSupabaseClient();
      
      const { data, error } = await supabase
        .from('ai_recipe_images')
        .upsert({
          recipe_hash: recipeHash,
          image_url: imageUrl,
          prompt_used: promptUsed,
          generation_cost: this.defaultCost,
          quality_score: 8 // Default quality score, can be updated later
        }, {
          onConflict: 'recipe_hash'
        })
        .select('*')
        .single();

      if (error) {
        console.error(`❌ [${requestId}] Failed to cache image:`, error);
        throw error;
      }

      console.log(`✅ [${requestId}] Image cached successfully with ID: ${data.id}`);
      return data;

    } catch (error) {
      console.error(`❌ [${requestId}] Image cache save failed:`, error);
      // Don't throw here - image generation succeeded, caching is optional
      console.log(`⚠️  [${requestId}] Continuing despite cache failure...`);
    }
  }

  // Generate images for multiple recipes in parallel
  async generateImagesForRecipes(recipes, userId = null) {
    const requestId = Math.random().toString(36).substring(7);
    const startTime = Date.now();

    try {
      console.log(`\n🎨 [${requestId}] Starting batch image generation for ${recipes.length} recipes...`);
      console.log(`👤 [${requestId}] User ID: ${userId || 'not provided'}`);
      
      // Validate input
      if (!recipes || recipes.length === 0) {
        throw new Error('No recipes provided for image generation');
      }
      
      // Log recipe details for debugging
      recipes.forEach((recipe, index) => {
        console.log(`🍽️ [${requestId}] Recipe ${index + 1}: "${recipe.title}" (${recipe.cuisine_type || 'unknown cuisine'})`);
        console.log(`🥕 [${requestId}] Key ingredients: ${recipe.key_ingredients?.length || 0} items`);
      });
      
      // Create promises for parallel generation with enhanced error handling
      const imagePromises = recipes.map(async (recipe, index) => {
        const recipeStartTime = Date.now();
        try {
          console.log(`🎨 [${requestId}] Starting image ${index + 1}/${recipes.length}: ${recipe.title}`);
          
          if (!recipe.title) {
            throw new Error(`Recipe ${index + 1} missing title`);
          }
          
          const imageUrl = await this.generateImage(
            recipe.title,
            recipe.key_ingredients || [],
            recipe.cuisine_type || 'default',
            userId
          );
          
          const recipeDuration = Date.now() - recipeStartTime;
          console.log(`✅ [${requestId}] Image ${index + 1} completed in ${recipeDuration}ms: ${imageUrl.substring(0, 50)}...`);
          return imageUrl;
        } catch (error) {
          const recipeDuration = Date.now() - recipeStartTime;
          console.error(`❌ [${requestId}] Image ${index + 1} failed after ${recipeDuration}ms:`, error.message);
          console.error(`📝 [${requestId}] Recipe details: ${JSON.stringify({
            title: recipe.title,
            cuisine: recipe.cuisine_type,
            ingredients: recipe.key_ingredients?.length || 0
          })}`);
          console.error(`🔍 [${requestId}] Full error stack:`, error.stack);
          
          throw new Error(`Image generation failed for "${recipe.title}": ${error.message}`);
        }
      });

      // Wait for all images 
      console.log(`⏳ [${requestId}] Waiting for all ${recipes.length} images to generate...`);
      const imageUrls = await Promise.all(imagePromises);
      
      // Analyze results
      const realImages = imageUrls.filter(url => !url.includes('unsplash.com') && !url.includes('placeholder'));
      const placeholderImages = imageUrls.filter(url => url.includes('unsplash.com') || url.includes('placeholder'));
      const totalDuration = Date.now() - startTime;
      
      console.log(`🎉 [${requestId}] Batch generation complete in ${totalDuration}ms:`);
      console.log(`✅ [${requestId}] Fresh images generated: ${realImages.length}/${recipes.length} (NO CACHE)`);
      console.log(`🔄 [${requestId}] Placeholder images used: ${placeholderImages.length}/${recipes.length}`);
      
      if (realImages.length === 0) {
        console.error(`⚠️ [${requestId}] WARNING: All images failed generation, using placeholders only`);
      } else {
        console.log(`🎯 [${requestId}] SUCCESS: Each recipe will get a unique, fresh image!`);
      }
      
      return imageUrls;

    } catch (error) {
      const totalDuration = Date.now() - startTime;
      console.error(`💥 [${requestId}] Batch image generation failed after ${totalDuration}ms:`, error.message);
      console.error(`🔍 [${requestId}] Full error stack:`, error.stack);
      
      throw new Error(`Image generation batch failure: ${error.message}`);
    }
  }

  // Get placeholder image URL for fallbacks
  getPlaceholderImageUrl(cuisineType = '') {
    // Use a food-related placeholder service or local placeholder
    const placeholders = {
      'italian': 'https://images.unsplash.com/photo-1498654896293-37aacf113fd9?w=512&h=512&fit=crop',
      'asian': 'https://images.unsplash.com/photo-1546833999-b9f581a1996d?w=512&h=512&fit=crop',
      'mexican': 'https://images.unsplash.com/photo-1565299624946-b28f40a0ca4b?w=512&h=512&fit=crop',
      'american': 'https://images.unsplash.com/photo-1571091718767-18b5b1457add?w=512&h=512&fit=crop',
      'default': 'https://images.unsplash.com/photo-1504674900247-0877df9cc836?w=512&h=512&fit=crop'
    };
    
    return placeholders[cuisineType.toLowerCase()] || placeholders.default;
  }

  // Update cached image with images (called after generation)
  async updateRecipeCacheWithImages(cacheId, imageUrls) {
    const requestId = Math.random().toString(36).substring(7);
    
    try {
      console.log(`🔄 [${requestId}] Updating recipe cache ${cacheId} with ${imageUrls.length} images...`);
      
      const supabase = getSupabaseClient();
      
      const { data, error } = await supabase
        .from('ai_generated_recipes')
        .update({
          image_urls: imageUrls,
          generation_status: 'completed'
        })
        .eq('id', cacheId)
        .select('*')
        .single();

      if (error) {
        console.error(`❌ [${requestId}] Failed to update recipe cache:`, error);
        throw error;
      }

      console.log(`✅ [${requestId}] Recipe cache updated with images`);
      return data;

    } catch (error) {
      console.error(`❌ [${requestId}] Cache update failed:`, error);
      throw error;
    }
  }

  // Get image generation statistics for analytics
  async getImageStats() {
    try {
      const supabase = getSupabaseClient();
      
      const { data, error } = await supabase
        .from('ai_recipe_images')
        .select('generation_cost, quality_score, created_at')
        .order('created_at', { ascending: false })
        .limit(100);

      if (error) throw error;

      const totalCost = data.reduce((sum, img) => sum + parseFloat(img.generation_cost || 0), 0);
      const avgQuality = data.reduce((sum, img) => sum + (img.quality_score || 5), 0) / data.length;
      
      return {
        totalImages: data.length,
        totalCost: totalCost,
        averageQuality: avgQuality,
        recentImages: data.slice(0, 10)
      };

    } catch (error) {
      console.log('Failed to get image stats:', error.message);
      return null;
    }
  }
}

module.exports = new ImageGenerationService();