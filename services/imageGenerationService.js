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

// Image Generation Service using Fireworks AI with FLUX.1 model
class ImageGenerationService {
  constructor() {
    this.baseUrl = 'https://api.fireworks.ai/inference/v1/workflows/accounts/fireworks/models/flux-1-schnell-fp8/text_to_image';
    this.model = 'flux-1-schnell-fp8'; // FLUX.1 schnell model for text-to-image
    this.defaultCost = 0.005; // $0.005 per image
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

  // Build optimized image prompt for food photography
  buildImagePrompt(recipeTitle, keyIngredients, cuisineType = '') {
    const ingredientsList = keyIngredients.join(', ');
    const cuisineContext = cuisineType ? `, ${cuisineType} style` : '';

    return {
      prompt: `professional food photography, overhead shot, ${recipeTitle}, beautifully plated and garnished, made with ${ingredientsList}${cuisineContext}, natural lighting, restaurant quality presentation, modern white ceramic plate, minimal styling, photorealistic, 4K quality, editorial food styling, warm color temperature, shallow depth of field, appetizing, fresh ingredients visible, clean composition, subtle shadows, high detail textures`,

      negative_prompt: `cartoon, illustration, anime, painting, sketch, text overlay, watermarks, logos, utensils in frame, hands, people, messy plating, plastic appearance, low quality, blurry, oversaturated, unappetizing, raw ingredients only, dark lighting, cluttered background, unrealistic colors`
    };
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

  // Generate image using Fireworks AI (no caching - always fresh)
  async generateImage(recipeTitle, keyIngredients, cuisineType = '', userId = null) {
    const requestId = Math.random().toString(36).substring(7);

    try {
      console.log(`\n🎨 =============== IMAGE GENERATION START ===============`);
      console.log(`🎨 REQUEST ID: ${requestId}`);
      console.log(`🎨 Recipe: ${recipeTitle}`);
      console.log(`🎨 Key ingredients: ${keyIngredients.join(', ')}`);
      console.log(`🎨 Using Fireworks AI FLUX.1 dev model (NO CACHE)`);
      console.log(`🎨 Timestamp: ${new Date().toISOString()}`);
      console.log(`🎨 ======================================================\n`);

      // Step 1: Validate API key
      console.log(`🔐 [${requestId}] Step 1: Validating Fireworks API key...`);
      if (!process.env.FIREWORKS_API_KEY) {
        throw new Error('FIREWORKS_API_KEY is missing from environment variables');
      }
      
      const apiKey = process.env.FIREWORKS_API_KEY;
      console.log(`🔐 [${requestId}] Fireworks API key validated: ${apiKey.substring(0, 10)}...${apiKey.substring(apiKey.length - 4)}`);
      console.log(`🌐 [${requestId}] Using endpoint: ${this.baseUrl}`);
      console.log(`🏷️  [${requestId}] Model: ${this.model}`);

      // Step 2: Build image generation prompt (removed cache check)
      console.log(`📝 [${requestId}] Step 2: Building image prompt...`);
      const { prompt, negative_prompt } = this.buildImagePrompt(recipeTitle, keyIngredients, cuisineType);
      
      console.log(`📝 [${requestId}] Prompt length: ${prompt.length} chars`);
      console.log(`📝 [${requestId}] Prompt preview: ${prompt.substring(0, 100)}...`);

      // Step 3: Prepare request body for Fireworks workflow endpoint
      const requestBody = {
        prompt: prompt,
        negative_prompt: negative_prompt,
        width: 512,
        height: 512,
        guidance_scale: 7.5, // Higher guidance for better prompt following
        num_inference_steps: 25, // Balance between quality and speed
        seed: Math.floor(Math.random() * 1000000), // Random seed for variety
        safety_check: false, // Food images are safe
        output_image_format: 'JPEG'
      };

      console.log(`⚙️  [${requestId}] Step 3: Prepared image generation request`);
      console.log(`📋 [${requestId}] Request body:`, JSON.stringify(requestBody, null, 2));

      // Step 4: Make API request to Fireworks
      console.log(`🌐 [${requestId}] Step 4: Making Fireworks AI request...`);
      console.log(`🎯 [${requestId}] Full URL: ${this.baseUrl}`);
      const fetchStartTime = Date.now();
      
      const requestOptions = {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(requestBody)
      };
      
      console.log(`📤 [${requestId}] Request headers:`, {
        'Authorization': `Bearer ${apiKey.substring(0, 10)}...${apiKey.substring(apiKey.length - 4)}`,
        'Content-Type': 'application/json'
      });
      
      const response = await fetch(this.baseUrl, requestOptions);
      
      const fetchDuration = Date.now() - fetchStartTime;
      console.log(`🌐 [${requestId}] API request completed in ${fetchDuration}ms`);
      console.log(`🌐 [${requestId}] Response status: ${response.status} ${response.statusText}`);
      console.log(`📋 [${requestId}] Response headers:`, Object.fromEntries(response.headers.entries()));

      if (!response.ok) {
        const errorText = await response.text();
        console.error(`❌ [${requestId}] Fireworks API error: ${response.status} - ${errorText}`);
        console.error(`🔍 [${requestId}] Error response details:`, {
          status: response.status,
          statusText: response.statusText,
          url: response.url,
          errorText: errorText
        });
        throw new Error(`Fireworks API error: ${response.status} ${response.statusText} - ${errorText}`);
      }

      // Step 5: Process response - handle both binary and JSON formats
      console.log(`📥 [${requestId}] Step 5: Processing image response...`);
      const contentType = response.headers.get('content-type') || '';
      console.log(`📋 [${requestId}] Response Content-Type: ${contentType}`);
      
      let imageUrl;
      
      if (contentType.includes('application/json')) {
        // Handle JSON response format
        console.log(`🔍 [${requestId}] Processing JSON response...`);
        const responseText = await response.text();
        console.log(`📄 [${requestId}] JSON response (first 500 chars):`, responseText.substring(0, 500));
        
        let result;
        try {
          result = JSON.parse(responseText);
          console.log(`📊 [${requestId}] Parsed JSON response:`, JSON.stringify(result, null, 2));
        } catch (parseError) {
          console.error(`❌ [${requestId}] Failed to parse JSON response:`, parseError.message);
          throw new Error(`Failed to parse Fireworks JSON response: ${parseError.message}`);
        }
        
        if (!result || !result.images || result.images.length === 0) {
          console.error(`❌ [${requestId}] No images in JSON response:`, result);
          throw new Error('No images returned in JSON from Fireworks API');
        }

        // Extract base64 from JSON response
        const base64Image = result.images[0].b64_json || result.images[0].url;
        if (!base64Image) {
          console.error(`❌ [${requestId}] No base64 image data found:`, result.images[0]);
          throw new Error('No image data returned in JSON from Fireworks API');
        }

        // Convert to data URL
        imageUrl = base64Image.startsWith('data:') ? base64Image : `data:image/jpeg;base64,${base64Image}`;
        console.log(`📥 [${requestId}] Image from JSON (base64): ${imageUrl.substring(0, 50)}...`);
        
      } else {
        // Handle binary image response (raw JPEG data)
        console.log(`🖼️  [${requestId}] Processing binary image response...`);
        const imageBuffer = await response.arrayBuffer();
        console.log(`📊 [${requestId}] Binary image size: ${imageBuffer.byteLength} bytes`);
        
        // Convert binary data to base64
        const base64String = Buffer.from(imageBuffer).toString('base64');
        console.log(`🔄 [${requestId}] Converted to base64, length: ${base64String.length} chars`);
        
        // Create data URL
        imageUrl = `data:image/jpeg;base64,${base64String}`;
        console.log(`📥 [${requestId}] Image from binary (base64): ${imageUrl.substring(0, 50)}...`);
      }

      console.log(`🎉 [${requestId}] Image generation complete! (No caching)`);

      // Upload to Supabase Storage instead of returning base64
      if (userId) {
        console.log(`📤 [${requestId}] Uploading to Supabase Storage...`);
        const recipeHash = this.generateRecipeHash(recipeTitle, keyIngredients);
        const permanentUrl = await this.uploadImageToSupabase(imageUrl, recipeHash, userId);
        console.log(`✅ [${requestId}] Permanent URL: ${permanentUrl}`);
        console.log(`\n✅ [${requestId}] =============== IMAGE GENERATION COMPLETE ===============\n`);
        return permanentUrl;
      } else {
        // Fallback: return base64 if no userId (shouldn't happen)
        console.warn(`⚠️  [${requestId}] No userId provided, returning base64 (not recommended)`);
        console.log(`\n✅ [${requestId}] =============== IMAGE GENERATION COMPLETE ===============\n`);
        return imageUrl;
      }

    } catch (error) {
      console.error(`\n💥 [${requestId}] ========== IMAGE GENERATION ERROR ==========`);
      console.error(`💥 [${requestId}] Error:`, error.message);
      console.error(`💥 [${requestId}] Stack:`, error.stack);
      console.error(`💥 [${requestId}] ==========================================\n`);
      throw error;
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
          
          // DEBUGGING: Throw the real error instead of using placeholders
          throw new Error(`Fireworks API failed for "${recipe.title}": ${error.message}`);
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
      
      // DEBUGGING: Throw the real error instead of using placeholders
      throw new Error(`Fireworks API batch failure: ${error.message}`);
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