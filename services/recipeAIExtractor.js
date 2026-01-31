const fetch = require('node-fetch');
const cheerio = require('cheerio');
const VideoProcessor = require('./videoProcessor');

class RecipeAIExtractor {
  constructor() {
    this.apiKey = process.env.OPENROUTER_API_KEY;
    this.videoProcessor = new VideoProcessor();
    // Primary model: Free Gemini 2.0 Flash (faster, newer)
    this.primaryModel = 'google/gemini-2.0-flash:free';
    // Fallback model: Gemini 2.5 Flash (reliable, fast)
    this.fallbackModel = 'google/gemini-2.5-flash';
    // Track usage for intelligent switching
    this.freeModelFailures = 0;
    this.freeModelSuccesses = 0;
    this.totalRequests = 0;
    this.lastResetAt = Date.now();
  }

  // Helper function to convert recipe fractions to decimal numbers for valid JSON
  sanitizeFractions(responseText) {
    console.log('[RecipeAIExtractor] Sanitizing fractions in AI response...');

    if (!responseText || typeof responseText !== 'string') {
      return responseText;
    }

    let sanitized = responseText;

    // Handle mixed numbers like "1 1/2" → "1.5"
    sanitized = sanitized.replace(
      /"amount":\s*(\d+)\s+(\d+)\s*\/\s*(\d+)/g,
      (match, whole, numerator, denominator) => {
        const decimal = parseFloat(whole) + (parseFloat(numerator) / parseFloat(denominator));
        console.log(`[RecipeAIExtractor] Converting mixed number ${whole} ${numerator}/${denominator} → ${decimal}`);
        return `"amount": ${decimal}`;
      }
    );

    // Handle simple fractions like "1/4" → "0.25"
    sanitized = sanitized.replace(
      /"amount":\s*(\d+)\s*\/\s*(\d+)/g,
      (match, numerator, denominator) => {
        const decimal = parseFloat(numerator) / parseFloat(denominator);
        console.log(`[RecipeAIExtractor] Converting fraction ${numerator}/${denominator} → ${decimal}`);
        return `"amount": ${decimal}`;
      }
    );

    // Handle common fraction words
    const fractionMap = {
      '"amount": "half"': '"amount": 0.5',
      '"amount": "quarter"': '"amount": 0.25',
      '"amount": "three quarters"': '"amount": 0.75'
    };

    Object.entries(fractionMap).forEach(([fraction, decimal]) => {
      if (sanitized.includes(fraction)) {
        console.log(`[RecipeAIExtractor] Converting word fraction ${fraction} → ${decimal}`);
        sanitized = sanitized.replace(new RegExp(fraction, 'g'), decimal);
      }
    });

    // Protect URLs from fraction conversion by temporarily replacing them
    const urlMap = new Map();
    let urlCounter = 0;

    // Extract and replace URLs with placeholders
    sanitized = sanitized.replace(/https?:\/\/[^\s"]+/g, (url) => {
      const placeholder = `__URL_PLACEHOLDER_${urlCounter++}__`;
      urlMap.set(placeholder, url);
      return placeholder;
    });

    // Now safely remove any remaining division operators that might be outside amount fields
    sanitized = sanitized.replace(/(\d+)\s*\/\s*(\d+)/g, (match, num, den) => {
      const decimal = parseFloat(num) / parseFloat(den);
      console.log(`[RecipeAIExtractor] Converting remaining fraction ${num}/${den} → ${decimal}`);
      return decimal.toString();
    });

    // Restore original URLs
    urlMap.forEach((originalUrl, placeholder) => {
      sanitized = sanitized.replace(placeholder, originalUrl);
    });

    if (sanitized !== responseText) {
      console.log('[RecipeAIExtractor] Fractions sanitized successfully');
    }

    return sanitized;
  }

  /**
   * Extract recipe from any web URL using AI
   * Fallback method when Spoonacular fails with 502/503/timeout
   * @param {string} url - The recipe page URL
   * @returns {object} - Recipe in Spoonacular-compatible format
   */
  async extractFromWebUrl(url) {
    console.log('[RecipeAIExtractor] 🌐 Starting web URL extraction:', url);

    try {
      // 1. Fetch the webpage
      const response = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9'
        },
        timeout: 15000
      });

      if (!response.ok) {
        throw new Error(`Failed to fetch page: ${response.status}`);
      }

      const html = await response.text();
      console.log('[RecipeAIExtractor] Fetched HTML, length:', html.length);

      // 2. Extract text content using cheerio
      const $ = cheerio.load(html);

      // Remove non-content elements
      $('script, style, nav, footer, header, aside, [role="navigation"], .ad, .advertisement, .sidebar').remove();

      const title = $('title').text().trim() || $('h1').first().text().trim() || '';
      const bodyText = $('body').text()
        .replace(/\s+/g, ' ')
        .trim()
        .substring(0, 10000); // Limit context size for AI

      console.log('[RecipeAIExtractor] Extracted content:', {
        title: title.substring(0, 100),
        bodyLength: bodyText.length
      });

      // 3. Build prompt for recipe extraction
      const prompt = this.buildWebExtractionPrompt(url, title, bodyText);

      // 4. Call AI (no media content for web extraction)
      const aiResponse = await this.callAI(prompt, []);

      // 5. Parse response
      const sanitized = this.sanitizeFractions(aiResponse);

      // Extract JSON from response (may have markdown code blocks)
      let jsonStr = sanitized;
      const jsonMatch = sanitized.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (jsonMatch) {
        jsonStr = jsonMatch[1].trim();
      }

      const result = JSON.parse(jsonStr);

      if (result.error) {
        throw new Error(result.error);
      }

      // 6. Transform to Spoonacular-compatible format
      const recipe = this.transformWebResultToSpoonacularFormat(result, url);

      console.log('[RecipeAIExtractor] ✅ Web extraction successful:', {
        title: recipe.title,
        ingredientCount: recipe.extendedIngredients?.length,
        stepCount: recipe.analyzedInstructions?.[0]?.steps?.length
      });

      return recipe;

    } catch (error) {
      console.error('[RecipeAIExtractor] ❌ Web extraction failed:', error.message);
      throw error;
    }
  }

  /**
   * Build prompt for web recipe extraction
   */
  buildWebExtractionPrompt(url, pageTitle, bodyText) {
    return `Extract the recipe from this webpage content.

URL: ${url}
Page Title: ${pageTitle}

PAGE CONTENT:
${bodyText}

Extract the recipe and return ONLY valid JSON (no markdown, no explanation) in this exact format:
{
  "title": "Recipe name",
  "summary": "Brief 1-2 sentence description",
  "image": null,
  "extendedIngredients": [
    {"id": 1, "amount": 2, "unit": "cups", "name": "flour", "original": "2 cups flour"}
  ],
  "analyzedInstructions": [
    {"name": "", "steps": [{"number": 1, "step": "First step description"}]}
  ],
  "readyInMinutes": 30,
  "cookingMinutes": 20,
  "servings": 4,
  "vegetarian": false,
  "vegan": false,
  "glutenFree": false,
  "dairyFree": false,
  "cuisines": [],
  "dishTypes": [],
  "diets": [],
  "sourceName": "Website name"
}

RULES:
- Extract ALL ingredients with amounts and units
- Extract ALL cooking steps in order
- Convert fractions to decimals (1/2 → 0.5, 1 1/2 → 1.5)
- If no recipe found on this page, return {"error": "No recipe found"}
- Return ONLY the JSON object, no other text`;
  }

  /**
   * Transform AI result to Spoonacular-compatible format
   */
  transformWebResultToSpoonacularFormat(aiResult, url) {
    // Ensure ingredients have proper IDs
    const ingredients = (aiResult.extendedIngredients || []).map((ing, index) => ({
      id: ing.id || index + 1,
      amount: ing.amount || 0,
      unit: ing.unit || '',
      name: ing.name || '',
      original: ing.original || `${ing.amount || ''} ${ing.unit || ''} ${ing.name || ''}`.trim()
    }));

    // Ensure instructions have proper structure
    const instructions = aiResult.analyzedInstructions || [];
    if (instructions.length === 0 && aiResult.steps) {
      // Handle case where AI returns steps directly
      instructions.push({
        name: '',
        steps: aiResult.steps.map((step, index) => ({
          number: index + 1,
          step: typeof step === 'string' ? step : step.step
        }))
      });
    }

    // Extract hostname for source name
    let sourceName = aiResult.sourceName || '';
    try {
      if (!sourceName) {
        sourceName = new URL(url).hostname.replace('www.', '');
      }
    } catch (e) {
      sourceName = 'Web Recipe';
    }

    return {
      title: aiResult.title || 'Recipe',
      summary: aiResult.summary || '',
      image: aiResult.image || null,
      extendedIngredients: ingredients,
      analyzedInstructions: instructions,
      readyInMinutes: aiResult.readyInMinutes || null,
      cookingMinutes: aiResult.cookingMinutes || null,
      preparationMinutes: aiResult.preparationMinutes || null,
      servings: aiResult.servings || 4,
      vegetarian: aiResult.vegetarian || false,
      vegan: aiResult.vegan || false,
      glutenFree: aiResult.glutenFree || false,
      dairyFree: aiResult.dairyFree || false,
      cuisines: aiResult.cuisines || [],
      dishTypes: aiResult.dishTypes || [],
      diets: aiResult.diets || [],
      sourceName: sourceName,
      sourceUrl: url,
      creditsText: sourceName
    };
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
        // Sanitize fractions before parsing JSON
        const sanitizedResponse = this.sanitizeFractions(response);
        result = JSON.parse(sanitizedResponse);
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

  // TIER 1: Caption-Based Processing (Fast & Cheap)
  async extractFromApifyData(apifyData) {
    console.log('[RecipeAIExtractor] Starting TIER 1 caption-based extraction:', {
      hasCaption: !!apifyData.caption,
      captionLength: apifyData.caption?.length || 0,
      captionPreview: apifyData.caption?.substring(0, 200),
      hasVideo: !!apifyData.videoUrl,
      videoDuration: apifyData.videoDuration,
      imageCount: apifyData.images?.length || 0
    });

    // Use raw Instagram caption directly - let AI handle natural language understanding
    console.log('[RecipeAIExtractor] Using raw caption for AI extraction (no preprocessing)');

    // Build Tier 1 prompt (caption-focused, no video analysis)
    const enhancedData = {
      ...apifyData,
      caption: apifyData.caption, // Use raw caption directly
      originalCaption: apifyData.caption
    };
    const prompt = this.buildTier1Prompt(enhancedData);

    try {
      // If no API key configured, return mock data for testing
      if (!this.apiKey) {
        console.log('[RecipeAIExtractor] No API key configured, returning Tier 1 mock data');
        return this.getMockRecipeWithVideo(apifyData);
      }

      // Tier 1 only uses images for context, NOT video
      const mediaContent = apifyData.images || [];

      const response = await this.callAI(prompt, mediaContent);
      let result;

      try {
        // Sanitize fractions before parsing JSON
        const sanitizedResponse = this.sanitizeFractions(response);
        result = JSON.parse(sanitizedResponse);
        console.log('[RecipeAIExtractor] TIER 1 extraction result:', {
          success: result.success,
          confidence: result.confidence,
          hasRecipe: !!result.recipe,
          title: result.recipe?.title,
          ingredientCount: result.recipe?.extendedIngredients?.length,
          stepCount: result.recipe?.analyzedInstructions?.[0]?.steps?.length
        });
      } catch (parseError) {
        console.error('[RecipeAIExtractor] Failed to parse TIER 1 response:', parseError);
        console.log('[RecipeAIExtractor] Raw AI response:', response);
        throw new Error('Invalid AI response format');
      }

      // Prepare source data for confidence scoring
      const sourceData = {
        hasCaption: !!apifyData.caption,
        hashtagCount: apifyData.hashtags?.length || 0,
        viewCount: apifyData.viewCount || 0,
        author: apifyData.author,
        hasVideo: false, // Tier 1 doesn't use video
        videoDuration: 0
      };

      // Validate and clean the result with source data
      const finalResult = this.validateAndTransformRecipe(result, sourceData);


      // Apply confidence boost
      if (confidenceBoost > 0) {
        finalResult.confidence = Math.min(1.0, finalResult.confidence + confidenceBoost);
      }

      // Mark as Tier 1 result
      finalResult.tier = 1;
      finalResult.extractionMethod = 'caption-based';

      console.log('[RecipeAIExtractor] Final TIER 1 result:', {
        success: finalResult.success,
        confidence: finalResult.confidence,
        tier: finalResult.tier,
        title: finalResult.recipe?.title
      });

      return finalResult;
    } catch (error) {
      console.error('[RecipeAIExtractor] TIER 1 extraction error:', error);
      return this.getErrorResponse(error.message);
    }
  }

  // TIER 3: Premium Multi-Modal Analysis with Frame Extraction (Most Comprehensive)
  async extractWithFrameSampling(apifyData) {
    console.log('[RecipeAIExtractor] Starting TIER 3 premium analysis with frame extraction');

    if (!apifyData.videoUrl || apifyData.videoDuration < 10) {
      console.log('[RecipeAIExtractor] Video too short or unavailable for Tier 3');
      return this.extractFromVideoData(apifyData); // Fall back to Tier 2
    }

    try {
      // Extract key frames for enhanced analysis
      const frameData = await this.videoProcessor.extractFramesFromVideo(
        apifyData.videoUrl,
        apifyData.videoDuration,
        {
          maxFrames: 8,
          smartSampling: true,
          extractAudio: false // Audio extraction pending implementation
        }
      );

      // Combine frame data with original Apify data
      const enhancedData = {
        ...apifyData,
        extractedFrames: frameData.frames,
        frameMetadata: frameData.metadata
      };

      // Build enhanced prompt with frame context
      const prompt = this.buildTier3Prompt(enhancedData);

      // Prepare media content with frames
      const mediaContent = [];

      // Add video URL
      if (apifyData.videoUrl) {
        mediaContent.push(this.videoProcessor.prepareVideoForAI(apifyData.videoUrl, {
          duration: apifyData.videoDuration,
          viewCount: apifyData.viewCount,
          author: apifyData.author?.username
        }));
      }

      // Add extracted frames
      frameData.frames.forEach((frame, index) => {
        mediaContent.push({
          type: 'image',
          url: frame.base64,
          context: `frame_${index}_${frame.context}`,
          timestamp: frame.timestamp
        });
      });

      const response = await this.callAI(prompt, mediaContent);
      const result = JSON.parse(this.sanitizeFractions(response));

      // Enhanced confidence for Tier 3
      result.tier = 3;
      result.extractionMethod = 'premium-frame-analysis';
      result.framesAnalyzed = frameData.frames.length;

      const sourceData = {
        hasCaption: !!apifyData.caption,
        hashtagCount: apifyData.hashtags?.length || 0,
        viewCount: apifyData.viewCount || 0,
        author: apifyData.author,
        hasVideo: true,
        videoUrl: apifyData.videoUrl,
        videoDuration: apifyData.videoDuration,
        framesExtracted: true
      };

      return this.validateAndTransformRecipe(result, sourceData);

    } catch (error) {
      console.error('[RecipeAIExtractor] Tier 3 frame extraction failed:', error);
      // Fall back to Tier 2 on failure
      return this.extractFromVideoData(apifyData);
    }
  }

  // Build Tier 3 prompt with frame context
  buildTier3Prompt(data) {
    const primaryImageUrl = data.images?.[0]?.url || 'https://images.unsplash.com/photo-1546069901-ba9599a7e63c';

    return `You are performing TIER 3 PREMIUM EXTRACTION with frame-by-frame analysis of ${data.extractedFrames?.length || 0} key frames.

FRAME ANALYSIS DATA:
${data.extractedFrames?.map((frame, i) => `
Frame ${i + 1} at ${frame.timestamp}s (${frame.context}):
- Context: ${frame.context === 'ingredient_display' ? 'Ingredients shown' :
           frame.context === 'preparation' ? 'Food preparation' :
           frame.context === 'cooking_process' ? 'Active cooking' :
           frame.context === 'finishing_touches' ? 'Final steps' :
           'Final presentation'}
`).join('\n') || 'No frames extracted'}

VIDEO METADATA:
Duration: ${data.videoDuration}s
View Count: ${data.viewCount || 0}
Author: @${data.author?.username || 'unknown'}

TIER 3 EXTRACTION REQUIREMENTS:
1. FRAME-BY-FRAME: Analyze each provided frame for specific recipe information
2. TEMPORAL FLOW: Understand the cooking sequence from frame timestamps
3. INGREDIENT IDENTIFICATION: List ALL ingredients visible across all frames
4. TECHNIQUE EXTRACTION: Identify cooking methods from visual evidence
5. ULTRA-HIGH CONFIDENCE: Tier 3 should achieve 0.8+ confidence
6. COMPLETENESS: Recipe should be fully actionable with all details

Return comprehensive JSON with confidence 0.8+ due to frame analysis.`;
  }

  // TIER 2: Multi-Modal Video Analysis (Comprehensive & Expensive)
  async extractFromVideoData(apifyData) {
    console.log('[RecipeAIExtractor] Starting TIER 2 video analysis:', {
      hasVideo: !!apifyData.videoUrl,
      videoDuration: apifyData.videoDuration,
      viewCount: apifyData.viewCount,
      hasCaption: !!apifyData.caption,
      captionLength: apifyData.caption?.length || 0,
      imageCount: apifyData.images?.length || 0,
      videoUrlExpiry: apifyData.videoUrlExpiry,
      timeUntilExpiry: apifyData.videoUrlExpiry ? Math.round((apifyData.videoUrlExpiry - Date.now()) / 1000) + 's' : 'N/A'
    });

    // Check video URL expiration
    if (apifyData.videoUrlExpiry && Date.now() > apifyData.videoUrlExpiry) {
      console.warn('[RecipeAIExtractor] Video URL has expired, falling back to Tier 1');
      return {
        success: false,
        confidence: 0,
        error: 'Video URL has expired - please re-import for video analysis',
        tier: 2,
        videoExpired: true,
        fallbackToTier1: true
      };
    }

    if (!apifyData.videoUrl) {
      console.log('[RecipeAIExtractor] No video available for TIER 2 analysis');
      return {
        success: false,
        confidence: 0,
        error: 'No video available for Tier 2 analysis',
        tier: 2
      };
    }

    // Build Tier 2 prompt (video-focused with enhanced context)
    const prompt = this.buildTier2Prompt(apifyData);

    try {
      // If no API key configured, return enhanced mock data
      if (!this.apiKey) {
        console.log('[RecipeAIExtractor] No API key configured, returning TIER 2 mock data');
        const mockResult = this.getMockRecipeWithVideo(apifyData);
        mockResult.tier = 2;
        mockResult.extractionMethod = 'video-analysis';
        mockResult.confidence = 0.85; // Higher confidence for video analysis
        return mockResult;
      }

      // Prepare enhanced video data for Gemini analysis
      const mediaContent = [];

      // Prepare video with analysis hints for better extraction
      if (apifyData.videoUrl) {
        console.log('[RecipeAIExtractor] Preparing video for enhanced AI analysis');
        const videoData = this.videoProcessor.prepareVideoForAI(apifyData.videoUrl, {
          duration: apifyData.videoDuration,
          viewCount: apifyData.viewCount,
          author: apifyData.author?.username
        });
        mediaContent.push(videoData);
      }

      // Add images as supplementary content
      if (apifyData.images && apifyData.images.length > 0) {
        apifyData.images.slice(0, 3).forEach((img, index) => {
          mediaContent.push({
            url: img.url || img,
            type: 'image',
            context: index === 0 ? 'thumbnail/cover' : 'additional'
          });
        });
      }

      const response = await this.callAI(prompt, mediaContent);
      let result;

      try {
        // Sanitize fractions before parsing JSON
        const sanitizedResponse = this.sanitizeFractions(response);
        result = JSON.parse(sanitizedResponse);
        console.log('[RecipeAIExtractor] TIER 2 extraction result:', {
          success: result.success,
          confidence: result.confidence,
          hasRecipe: !!result.recipe,
          title: result.recipe?.title,
          videoAnalyzed: true,
          ingredientCount: result.recipe?.extendedIngredients?.length,
          stepCount: result.recipe?.analyzedInstructions?.[0]?.steps?.length
        });
      } catch (parseError) {
        console.error('[RecipeAIExtractor] Failed to parse TIER 2 response:', parseError);
        console.log('[RecipeAIExtractor] Raw AI response:', response);
        throw new Error('Invalid AI response format');
      }

      // Prepare enhanced source data for Tier 2 confidence scoring
      const sourceData = {
        hasCaption: !!apifyData.caption,
        hashtagCount: apifyData.hashtags?.length || 0,
        viewCount: apifyData.viewCount || 0,
        author: apifyData.author,
        hasVideo: !!apifyData.videoUrl,
        videoUrl: apifyData.videoUrl,
        videoDuration: apifyData.videoDuration
      };

      // Validate and clean the result with enhanced source data
      const finalResult = this.validateAndTransformRecipe(result, sourceData);

      // Mark as Tier 2 result
      finalResult.tier = 2;
      finalResult.extractionMethod = 'video-analysis';
      finalResult.videoAnalyzed = true;

      console.log('[RecipeAIExtractor] Final TIER 2 result:', {
        success: finalResult.success,
        confidence: finalResult.confidence,
        videoConfidence: finalResult.videoConfidence,
        tier: finalResult.tier,
        title: finalResult.recipe?.title
      });

      return finalResult;
    } catch (error) {
      console.error('[RecipeAIExtractor] TIER 2 extraction error:', error);
      const errorResult = this.getErrorResponse(error.message);
      errorResult.tier = 2;
      return errorResult;
    }
  }

  // TIER 1 PROMPT: Caption-focused, no video analysis
  buildTier1Prompt(data) {
    const hasCaption = data.caption && data.caption.length > 10;
    const hasImages = data.images && data.images.length > 0;
    const primaryImageUrl = data.images?.[0]?.url || 'https://images.unsplash.com/photo-1546069901-ba9599a7e63c';

    return `You are a professional recipe extractor performing TIER 1 CAPTION-BASED ANALYSIS. Focus exclusively on text content - do NOT consider video data.

POST CONTENT (TIER 1 - CAPTION ANALYSIS):
Raw Instagram Caption: ${data.caption || 'No caption provided - ANALYZE IMAGES FOR TEXT OVERLAYS'}
${data.originalCaption && data.originalCaption !== data.caption ? `Original Caption: ${data.originalCaption.substring(0, 300)}...` : ''}
Hashtags: ${data.hashtags?.join(', ') || 'None'}
Author: @${data.author?.username || 'unknown'}
Has ${data.images?.length || 0} image(s) for text analysis

TIER 1 EXTRACTION RULES (RAW CAPTION ANALYSIS):
1. RAW INSTAGRAM CAPTION: Extract ingredients and instructions from unstructured Instagram text
2. LOOK FOR INGREDIENTS ANYWHERE: bullet points (•), dashes (-), measurements (2 cups, 1 lb), or inline mentions
3. LOOK FOR INSTRUCTIONS ANYWHERE: cooking verbs (slice, place, drizzle, bake, cook, mix, stir, add, remove, fill, top, cover, season), numbered steps, or narrative cooking descriptions
4. EXTRACT BOTH INGREDIENTS AND INSTRUCTIONS: Even if mixed with other content or informal language
5. BE FLEXIBLE: Instagram recipes are casual - don't require perfect formatting
6. DO NOT consider video content - focus ONLY on caption and image text overlays
7. CONFIDENCE: Higher if you find clear ingredients AND cooking steps, lower if only partial recipe info

CRITICAL JSON FORMAT REQUIREMENTS:
- Convert ALL recipe fractions to decimal numbers in JSON
- Examples: 1/4 → 0.25, 1/2 → 0.5, 3/4 → 0.75, 1 1/2 → 1.5, 2 3/4 → 2.75
- NEVER use mathematical expressions like "1 / 4" in JSON - always use decimal numbers
- The "amount" field must always be a valid number, never a string or expression
- IMPORTANT: Use the actual image URL "${primaryImageUrl}" in the "image" field - do NOT use placeholder text!

${!hasCaption && hasImages ? `
CRITICAL: No caption available - analyze IMAGES for text overlays only!
- Look for text overlays showing ingredients or instructions
- Identify ingredient lists in images
- Extract cooking steps from text in images
- Do NOT infer from visual content - only from readable text
` : ''}

RETURN THIS EXACT JSON FORMAT with TIER 1 confidence levels:
{
  "success": true,
  "confidence": 0.0-1.0 (caption-based only, 0.8+ for structured recipes),
  "recipe": {
    "title": "Recipe name from caption/text only",
    "summary": "A detailed 2-3 sentence description based on caption",
    "image": "${primaryImageUrl}",

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
            "step": "Detailed step from caption text"
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
  "extractionNotes": "Tier 1 caption-based extraction",
  "missingInfo": [],
  "requiresUserInput": false,
  "tier": 1
}`;
  }

  // TIER 2 PROMPT: Video-focused with comprehensive analysis
  buildTier2Prompt(data) {
    const hasCaption = data.caption && data.caption.length > 10;
    const hasVideo = !!data.videoUrl;
    const hasImages = data.images && data.images.length > 0;
    const primaryImageUrl = data.images?.[0]?.url || 'https://images.unsplash.com/photo-1546069901-ba9599a7e63c';

    return `You are a professional recipe extractor performing TIER 2 VIDEO ANALYSIS. This is premium extraction using comprehensive multi-modal analysis.

POST CONTENT (TIER 2 - VIDEO ANALYSIS):
${hasCaption ? `Caption Context: ${data.caption.substring(0, 300)}...` : 'No caption - relying on visual analysis'}
Hashtags: ${data.hashtags?.join(', ') || 'None'}
Author: @${data.author?.username || 'unknown'}
Has ${data.images?.length || 0} high-quality image(s)
${hasVideo ? `VIDEO AVAILABLE: ${data.videoDuration} seconds of cooking footage (${data.viewCount || 0} views)` : 'No video'}

${hasVideo ? `
TIER 2 VIDEO DEEP ANALYSIS INSTRUCTIONS:

🎥 FRAME-BY-FRAME ANALYSIS:
- SCAN the entire ${data.videoDuration}-second video for ingredient reveals
- IDENTIFY text overlays that appear at ANY point (often quick, 1-2 seconds)
- CAPTURE ingredient quantities shown visually (measuring cups, packages, containers)
- DETECT scene transitions that indicate new cooking phases
- ANALYZE hand movements and cooking techniques demonstrated
- NOTE timing of each cooking action (sautéing duration, baking time shown)

📝 TEXT OVERLAY EXTRACTION:
- TEXT OVERLAYS are CRITICAL - they often contain the COMPLETE recipe
- Look for ingredient lists that flash on screen (often at video start)
- Capture step-by-step instructions shown as text during cooking
- Extract measurements/quantities from on-screen text ("2 cups", "350°F")
- Identify recipe tips or notes shown as captions during specific moments

🎵 AUDIO/NARRATION ANALYSIS:
- LISTEN for verbal instructions and ingredient callouts
- Extract cooking temperatures and times mentioned verbally
- Capture tips and techniques explained through narration
- Identify background discussions about ingredients or methods
- Note any verbal cues about substitutions or variations

👁️ VISUAL INGREDIENT DETECTION:
- COUNT distinct ingredients shown (even if not mentioned in caption)
- IDENTIFY packages, bottles, and containers with visible labels
- ESTIMATE quantities based on visual portion sizes
- RECOGNIZE fresh ingredients by appearance (vegetables, proteins, herbs)
- DETECT pre-made components (sauces, broths, prepared items)

⏱️ TEMPORAL SEQUENCE MAPPING:
- First 5 seconds: Often shows all ingredients laid out
- 10-30% mark: Preparation techniques (chopping, marinating)
- 30-70% mark: Main cooking process (heat application, combining)
- 70-90% mark: Final assembly and plating
- Last 5 seconds: Finished dish glamour shot

🔍 COOKING TECHNIQUE ANALYSIS:
- Identify cooking methods: sautéing, baking, grilling, steaming, etc.
- Detect heat levels from visual cues (flame size, steam, bubbling)
- Note cooking vessel types and sizes (affects cooking times)
- Observe mixing/folding techniques that affect texture
- Identify garnishing and plating techniques
` : ''}

TIER 2 EXTRACTION RULES (ENHANCED MULTI-MODAL):
1. COMPLETE VIDEO SCAN: Analyze EVERY second for recipe information
2. TEXT OVERLAY PRIORITY: Text on video overrides caption text
3. VISUAL EVIDENCE: Trust what you SEE over what's written
4. AUDIO EXTRACTION: Verbal instructions are authoritative
5. INGREDIENT COMPLETENESS: List ALL ingredients shown, even briefly
6. TEMPORAL ACCURACY: Use video timeline for actual cooking times
7. CONFIDENCE BOOSTING: More visual evidence = higher confidence
8. MISSING INFO DETECTION: Flag any gaps in recipe completeness
9. CROSS-VALIDATION: Compare caption, visual, audio, and text overlay data

CRITICAL JSON FORMAT REQUIREMENTS:
- Convert ALL recipe fractions to decimal numbers in JSON
- Examples: 1/4 → 0.25, 1/2 → 0.5, 3/4 → 0.75, 1 1/2 → 1.5, 2 3/4 → 2.75
- NEVER use mathematical expressions like "1 / 4" in JSON - always use decimal numbers
- The "amount" field must always be a valid number, never a string or expression
- IMPORTANT: Use the actual image URL "${primaryImageUrl}" in the "image" field - do NOT use placeholder text!

${!hasVideo ? `
WARNING: No video available for Tier 2 analysis!
- This should not happen in proper tiered extraction
- Return low confidence and require fallback
` : ''}

RETURN THIS EXACT JSON FORMAT with TIER 2 enhanced confidence:
{
  "success": true,
  "confidence": 0.0-1.0 (video-enhanced, 0.7+ expected for Tier 2),
  "recipe": {
    "title": "Recipe name (enhanced by video content)",
    "summary": "A detailed 2-3 sentence description based on video and caption",
    "image": "${primaryImageUrl}",

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
            "step": "Detailed step based on video demonstration and visual cues"
          }
        ]
      }
    ],

    "readyInMinutes": ${hasVideo ? Math.max(30, Math.ceil(data.videoDuration / 60) * 5) : 30},
    "cookingMinutes": ${hasVideo ? Math.max(20, Math.ceil(data.videoDuration / 60) * 4) : 20},
    "servings": 4,

    "vegetarian": false,
    "vegan": false,
    "glutenFree": false,
    "dairyFree": false,
    "veryHealthy": false,
    "cheap": false,
    "veryPopular": ${data.viewCount > 10000 ? 'true' : 'false'},

    "cuisines": ["Italian"],
    "dishTypes": ["main course", "dinner"],
    "diets": [],

    "nutrition": null
  },
  "extractionNotes": "Tier 2 video analysis with enhanced multi-modal processing",
  "missingInfo": [],
  "requiresUserInput": false,
  "videoAnalyzed": true,
  "tier": 2
}`;
  }

  buildApifyPrompt(data) {
    const hasCaption = data.caption && data.caption.length > 10;
    const hasVideo = !!data.videoUrl;
    const hasImages = data.images && data.images.length > 0;
    const primaryImageUrl = data.images?.[0]?.url || 'https://images.unsplash.com/photo-1546069901-ba9599a7e63c';

    return `You are a professional recipe extractor with VIDEO ANALYSIS capabilities. Analyze this Instagram post with ENHANCED DATA from Apify.

POST CONTENT (PREMIUM APIFY DATA):
Raw Instagram Caption: ${data.caption || 'No caption provided - ANALYZE IMAGES/VIDEO CAREFULLY'}
${data.originalCaption && data.originalCaption !== data.caption ? `Original Caption: ${data.originalCaption.substring(0, 300)}...` : ''}
Hashtags: ${data.hashtags?.join(', ') || 'None'}
Author: @${data.author?.username || 'unknown'}
Has ${data.images?.length || 0} high-quality image(s)
${hasVideo ? `VIDEO AVAILABLE: ${data.videoDuration} seconds of cooking footage (${data.viewCount || 0} views)` : 'No video'}

${hasVideo ? `
IMPORTANT VIDEO CONTEXT:
- A ${data.videoDuration}-second cooking video is available showing the complete preparation
- Video likely contains visual cooking steps, techniques, and timing information
- Consider that ingredients shown in video may be more complete than caption
- Cooking techniques and methods are demonstrated visually
- Use video duration to estimate actual cooking time if not specified
` : ''}

EXTRACTION RULES FOR PREMIUM CONTENT:
1. RAW INSTAGRAM CAPTION: Extract ingredients and instructions from unstructured text using natural language understanding
2. LOOK FOR INGREDIENTS EVERYWHERE: bullet points (•), dashes (-), measurements, inline mentions, or any food items mentioned
3. LOOK FOR COOKING INSTRUCTIONS EVERYWHERE: any cooking verbs (slice, place, drizzle, bake, cook, mix, stir, add, remove, fill, top, cover, season, etc.), numbered steps, or narrative cooking descriptions
4. BE COMPREHENSIVE: Extract ALL ingredients AND cooking steps, even if scattered throughout the caption
5. With video available, confidence should be HIGHER as visual demonstration provides clarity
6. Video recipes often show ingredients at the beginning - consider this
7. Video duration can indicate cooking complexity (longer = more steps)
8. Visual cooking cues from video override text when conflicting
9. Premium extraction should yield MORE COMPLETE recipes with BOTH ingredients and instructions

CRITICAL JSON FORMAT REQUIREMENTS:
- Convert ALL recipe fractions to decimal numbers in JSON
- Examples: 1/4 → 0.25, 1/2 → 0.5, 3/4 → 0.75, 1 1/2 → 1.5, 2 3/4 → 2.75
- NEVER use mathematical expressions like "1 / 4" in JSON - always use decimal numbers
- The "amount" field must always be a valid number, never a string or expression
- IMPORTANT: Use the actual image URL "${primaryImageUrl}" in the "image" field - do NOT use placeholder text!

${!hasCaption && hasVideo ? `
CRITICAL: Video-based recipe - extract based on visual content!
- The video shows the complete cooking process
- Ingredients are likely shown at the start of the video
- Each scene change might indicate a new cooking step
- Final dish appearance helps identify the recipe type
` : ''}

RETURN THIS EXACT JSON FORMAT with ENHANCED CONFIDENCE due to video/premium data:
{
  "success": true,
  "confidence": 0.0-1.0 (boost by 0.2 if video available),
  "recipe": {
    "title": "Recipe name (be specific based on video content)",
    "summary": "A detailed 2-3 sentence description based on video and images",
    "image": "${primaryImageUrl}",

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
            "step": "Detailed step based on video demonstration"
          }
        ]
      }
    ],

    "readyInMinutes": ${hasVideo ? Math.max(30, Math.ceil(data.videoDuration / 60) * 5) : 30},
    "cookingMinutes": ${hasVideo ? Math.max(20, Math.ceil(data.videoDuration / 60) * 4) : 20},
    "servings": 4,

    "vegetarian": false,
    "vegan": false,
    "glutenFree": false,
    "dairyFree": false,
    "veryHealthy": false,
    "cheap": false,
    "veryPopular": ${data.viewCount > 10000 ? 'true' : 'false'},

    "cuisines": ["Italian"],
    "dishTypes": ["main course", "dinner"],
    "diets": [],

    "nutrition": null
  },
  "extractionNotes": "Premium extraction with video analysis provides higher confidence",
  "missingInfo": [],
  "requiresUserInput": false,
  "videoAnalyzed": ${hasVideo ? 'true' : 'false'}
}`;
  }

  buildPrompt(data) {
    const hasCaption = data.caption && data.caption.length > 10;
    const hasImages = data.images && data.images.length > 0;
    const hasVideo = data.videos && data.videos.length > 0;
    const primaryImageUrl = data.images?.[0]?.url || data.images?.[0] || 'https://images.unsplash.com/photo-1546069901-ba9599a7e63c';

    return `You are a professional recipe extractor. Analyze this Instagram post and extract a complete recipe.

POST CONTENT:
Caption: ${data.caption || 'No caption provided - ANALYZE IMAGES/VIDEO CAREFULLY'}
Hashtags: ${data.hashtags?.join(', ') || 'None'}
Author: @${data.author?.username || 'unknown'}
Has ${data.images?.length || 0} image(s)
${data.videos?.length ? `Has video (${data.videos[0].duration}s)` : ''}

${!hasCaption && (hasImages || hasVideo) ? `
CRITICAL: No caption text available - you MUST analyze the visual content!
- Look for text overlays in images showing ingredients or instructions
- Identify ingredients visible in preparation photos
- Infer cooking steps from sequential images
- Use any text visible in the images/video
- Make educated guesses based on the dish appearance
` : ''}

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

CRITICAL JSON FORMAT REQUIREMENTS:
- Convert ALL recipe fractions to decimal numbers in JSON
- Examples: 1/4 → 0.25, 1/2 → 0.5, 3/4 → 0.75, 1 1/2 → 1.5, 2 3/4 → 2.75
- NEVER use mathematical expressions like "1 / 4" in JSON - always use decimal numbers
- The "amount" field must always be a valid number, never a string or expression
- IMPORTANT: Use the actual image URL "${primaryImageUrl}" in the "image" field - do NOT use placeholder text!

RETURN THIS EXACT JSON FORMAT:
{
  "success": true,
  "confidence": 0.0-1.0,
  "recipe": {
    "title": "Recipe name",
    "summary": "A brief 1-2 sentence description of the dish",
    "image": "${primaryImageUrl}",
    
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

  async callAI(prompt, mediaContent = []) {
    const contentParts = [{ type: 'text', text: prompt }];

    // Process media content with type awareness
    for (const media of mediaContent.slice(0, 5)) {
      if (media.type === 'video') {
        // For video, send the URL with analysis hints
        contentParts.push({
          type: 'image_url',
          image_url: {
            url: media.url,
            detail: 'high' // Request detailed analysis
          }
        });

        // Add analysis hints as supplementary text
        if (media.analysisHints) {
          const hintsText = `
VIDEO ANALYSIS FOCUS POINTS:
- Duration: ${media.duration} seconds
- Key timestamps to analyze: ${media.analysisHints.focusTimestamps.join(', ')} seconds
- Expected sections: ${media.analysisHints.expectedSections.map(s =>
            `${Math.round(s.start * media.duration)}s-${Math.round(s.end * media.duration)}s: ${s.focus}`
          ).join(', ')}
- Scan for text overlays and ingredient displays
- Extract audio narration if present`;

          contentParts.push({ type: 'text', text: hintsText });
        }
      } else if (media.type === 'image' || media.url) {
        // Regular image handling
        contentParts.push({
          type: 'image_url',
          image_url: {
            url: media.url || media,
            detail: media.context === 'thumbnail/cover' ? 'high' : 'low'
          }
        });
      }
    }

    const messages = [{
      role: 'user',
      content: contentParts
    }];

    // Try free model first, with fallback to paid model
    return await this.callAIWithFallback(messages, prompt, mediaContent);
  }

  // Reset free model stats periodically or when requested
  resetFreeModelStats() {
    console.log('[RecipeAIExtractor] 🔄 Resetting free model statistics');
    this.freeModelFailures = 0;
    this.freeModelSuccesses = 0;
    this.totalRequests = 0;
    this.lastResetAt = Date.now();
  }

  async callAIWithFallback(messages, prompt, mediaContent = []) {
    this.totalRequests++;

    // Reset stats every 50 requests or every 24 hours to give free model fresh chances
    const hoursSinceReset = (Date.now() - this.lastResetAt) / (1000 * 60 * 60);
    const shouldReset = this.totalRequests % 50 === 0 ||
                       hoursSinceReset >= 24 ||
                       process.env.RESET_AI_STATS === 'true';

    if (shouldReset) {
      this.resetFreeModelStats();
    }

    // Environment variable to force free model usage (for testing/cost optimization)
    const forceFreeModel = process.env.FORCE_FREE_AI_MODEL === 'true';

    // Determine which model to try first based on recent success rates
    const freeModelSuccessRate = this.freeModelSuccesses / Math.max(1, this.freeModelSuccesses + this.freeModelFailures);
    const shouldUseFreeFirst = forceFreeModel || freeModelSuccessRate >= 0.1; // Lowered threshold to 10%

    console.log('[RecipeAIExtractor] === MODEL SELECTION ===');
    console.log('[RecipeAIExtractor] Free model stats:', {
      successes: this.freeModelSuccesses,
      failures: this.freeModelFailures,
      successRate: freeModelSuccessRate.toFixed(2),
      totalRequests: this.totalRequests,
      hoursSinceReset: hoursSinceReset.toFixed(1),
      forceFreeModel: forceFreeModel,
      usingFreeFirst: shouldUseFreeFirst
    });

    if (shouldUseFreeFirst) {
      // Try free model first
      try {
        console.log('[RecipeAIExtractor] Attempting free Gemini 2.0 Flash...');
        const result = await this.makeAPICall(messages, this.primaryModel, 'free');
        this.freeModelSuccesses++;
        console.log('[RecipeAIExtractor] ✅ Free model succeeded');
        return result;
      } catch (error) {
        console.log('[RecipeAIExtractor] ❌ Free model failed:', error.message);

        // Only count as failure if it's not a temporary rate limit
        const isRateLimit = error.message.includes('quota') ||
                           error.message.includes('rate limit') ||
                           error.message.includes('429');

        if (isRateLimit) {
          console.log('[RecipeAIExtractor] 🕒 Rate limit detected - not counting as failure');
        } else {
          this.freeModelFailures++;
          console.log('[RecipeAIExtractor] 📊 Counting as failure (not rate limit)');
        }

        // Fallback to paid model
        console.log('[RecipeAIExtractor] Falling back to paid model...');
        try {
          const result = await this.makeAPICall(messages, this.fallbackModel, 'paid');
          console.log('[RecipeAIExtractor] ✅ Paid model succeeded as fallback');
          return result;
        } catch (paidError) {
          console.error('[RecipeAIExtractor] ❌ Both models failed');
          throw paidError;
        }
      }
    } else {
      // Use paid model directly if free model has low success rate
      console.log('[RecipeAIExtractor] Using paid model directly due to low free model success rate');
      return await this.makeAPICall(messages, this.fallbackModel, 'paid');
    }
  }

  async makeAPICall(messages, model, tier) {
    console.log('[RecipeAIExtractor] Making API call with model:', model, `(${tier})`);

    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://fridgy.app',
        'X-Title': 'Fridgy Recipe Import'
      },
      body: JSON.stringify({
        model: model,
        messages,
        response_format: { type: 'json_object' },
        temperature: 0.3,
        max_tokens: 2000
      })
    });

    const data = await response.json();

    if (!response.ok) {
      console.error('[RecipeAIExtractor] API Error:', data);

      // Handle specific error types for free model
      if (tier === 'free' && (
        data.error?.message?.includes('quota') ||
        data.error?.message?.includes('rate limit') ||
        data.error?.message?.includes('free tier') ||
        response.status === 429
      )) {
        throw new Error(`Free tier limited: ${data.error?.message || 'Rate limit exceeded'}`);
      }

      throw new Error(data.error?.message || `AI API error (${response.status})`);
    }

    if (!data.choices?.[0]?.message?.content) {
      throw new Error('Invalid API response format');
    }

    return data.choices[0].message.content;
  }

  /**
   * Calculate comprehensive confidence score based on multiple factors
   * @param {object} result - AI extraction result
   * @param {object} sourceData - Original source data (Apify/Instagram)
   * @returns {number} - Confidence score between 0 and 1
   */
  calculateConfidenceScore(result, sourceData = {}) {
    const recipe = result.recipe || {};
    const scores = {
      base: 0.3,        // Base confidence for any extraction
      ingredients: 0,    // Up to 0.25
      instructions: 0,   // Up to 0.25
      metadata: 0,       // Up to 0.1
      source: 0,         // Up to 0.1
      video: 0           // Video bonus up to 0.15
    };

    // Ingredient scoring (0-0.25)
    if (recipe.extendedIngredients?.length > 0) {
      const ingredientScore = Math.min(recipe.extendedIngredients.length / 10, 1);
      const hasQuantities = recipe.extendedIngredients.filter(i => i.amount > 0).length / recipe.extendedIngredients.length;
      scores.ingredients = (ingredientScore * 0.15) + (hasQuantities * 0.1);
    }

    // Instruction scoring (0-0.25)
    const steps = recipe.analyzedInstructions?.[0]?.steps || [];
    if (steps.length > 0) {
      const stepScore = Math.min(steps.length / 8, 1);
      const avgStepLength = steps.reduce((sum, s) => sum + (s.step?.length || 0), 0) / steps.length;
      const detailScore = Math.min(avgStepLength / 100, 1);
      scores.instructions = (stepScore * 0.15) + (detailScore * 0.1);
    }

    // Metadata scoring (0-0.1)
    if (recipe.title && recipe.title !== 'Untitled Recipe') scores.metadata += 0.04;
    if (recipe.summary && recipe.summary.length > 20) scores.metadata += 0.03;
    if (recipe.readyInMinutes && recipe.readyInMinutes !== 30) scores.metadata += 0.02;
    if (recipe.cuisines?.length > 0 || recipe.dishTypes?.length > 0) scores.metadata += 0.01;

    // Source quality scoring (0-0.1)
    if (sourceData.hasCaption) scores.source += 0.04;
    if (sourceData.hashtagCount > 3) scores.source += 0.02;
    if (sourceData.viewCount > 10000) scores.source += 0.02;
    if (sourceData.author?.isVerified) scores.source += 0.02;

    // Video analysis bonus (0-0.15)
    if (sourceData.hasVideo || sourceData.videoUrl) {
      scores.video += 0.05; // Base video bonus
      if (sourceData.videoDuration > 30) scores.video += 0.05; // Longer videos typically more detailed
      if (result.videoAnalyzed || result.tier === 2) scores.video += 0.05; // Tier 2 analysis bonus
    }

    // Calculate total confidence
    const totalScore = Object.values(scores).reduce((sum, score) => sum + score, 0);

    // Apply extraction tier multiplier
    let tierMultiplier = 1.0;
    if (result.tier === 2) tierMultiplier = 1.15; // 15% boost for Tier 2
    else if (result.tier === 1) tierMultiplier = 1.0; // No change for Tier 1

    const finalConfidence = Math.min(totalScore * tierMultiplier, 1.0);

    // Log confidence breakdown for debugging
    console.log('[RecipeAIExtractor] Confidence breakdown:', {
      scores,
      totalScore,
      tierMultiplier,
      finalConfidence,
      tier: result.tier
    });

    return finalConfidence;
  }

  validateAndTransformRecipe(result, sourceData = {}) {
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

    // Use the comprehensive confidence scoring system
    result.confidence = this.calculateConfidenceScore(result, sourceData);

    // Success determination with minimum thresholds
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

  // Enhanced mock recipe for testing with video data
  getMockRecipeWithVideo(apifyData) {
    const mockRecipe = {
      success: true,
      confidence: 0.98, // Higher confidence due to video
      videoConfidence: 0.98,
      recipe: {
        title: "Premium Video Recipe: Creamy Tuscan Chicken",
        summary: "A restaurant-quality dish featuring tender chicken breasts in a rich, creamy sauce with sun-dried tomatoes and spinach. This recipe was extracted with premium video analysis for enhanced accuracy.",
        image: apifyData.images?.[0]?.url || 'https://images.unsplash.com/photo-1546069901-ba9599a7e63c',

        extendedIngredients: [
          {
            id: 1,
            amount: 4,
            unit: "pieces",
            name: "chicken breasts",
            original: "4 boneless, skinless chicken breasts",
            meta: ["boneless", "skinless"]
          },
          {
            id: 2,
            amount: 2,
            unit: "tablespoons",
            name: "olive oil",
            original: "2 tablespoons olive oil",
            meta: []
          },
          {
            id: 3,
            amount: 3,
            unit: "cloves",
            name: "garlic",
            original: "3 cloves garlic, minced",
            meta: ["minced"]
          },
          {
            id: 4,
            amount: 1,
            unit: "cup",
            name: "heavy cream",
            original: "1 cup heavy cream",
            meta: []
          },
          {
            id: 5,
            amount: 0.5,
            unit: "cup",
            name: "sun-dried tomatoes",
            original: "1/2 cup sun-dried tomatoes, chopped",
            meta: ["chopped"]
          },
          {
            id: 6,
            amount: 2,
            unit: "cups",
            name: "baby spinach",
            original: "2 cups fresh baby spinach",
            meta: ["fresh"]
          },
          {
            id: 7,
            amount: 0.5,
            unit: "cup",
            name: "Parmesan cheese",
            original: "1/2 cup grated Parmesan cheese",
            meta: ["grated"]
          },
          {
            id: 8,
            amount: 1,
            unit: "teaspoon",
            name: "Italian seasoning",
            original: "1 teaspoon Italian seasoning",
            meta: []
          }
        ],

        analyzedInstructions: [
          {
            name: "",
            steps: [
              {
                number: 1,
                step: "Season chicken breasts with salt, pepper, and Italian seasoning on both sides."
              },
              {
                number: 2,
                step: "Heat olive oil in a large skillet over medium-high heat."
              },
              {
                number: 3,
                step: "Sear chicken breasts for 6-7 minutes per side until golden brown and cooked through (internal temp 165°F)."
              },
              {
                number: 4,
                step: "Remove chicken from pan and set aside."
              },
              {
                number: 5,
                step: "In the same pan, sauté minced garlic for 30 seconds until fragrant."
              },
              {
                number: 6,
                step: "Add heavy cream and bring to a gentle simmer."
              },
              {
                number: 7,
                step: "Stir in sun-dried tomatoes and Parmesan cheese until cheese melts."
              },
              {
                number: 8,
                step: "Add spinach and cook until wilted, about 2 minutes."
              },
              {
                number: 9,
                step: "Return chicken to the pan and spoon sauce over top."
              },
              {
                number: 10,
                step: "Simmer for 2-3 minutes to heat through and serve immediately."
              }
            ]
          }
        ],

        // Enhanced timing based on "video duration"
        readyInMinutes: apifyData.videoDuration ? Math.max(35, Math.ceil(apifyData.videoDuration / 60) * 5) : 35,
        cookingMinutes: 30,
        servings: 4,

        vegetarian: false,
        vegan: false,
        glutenFree: false,
        dairyFree: false,
        veryHealthy: false,
        cheap: false,
        veryPopular: apifyData.viewCount > 10000,

        cuisines: ["Italian", "Mediterranean"],
        dishTypes: ["main course", "dinner"],
        diets: [],

        nutrition: null
      },
      extractionNotes: `Premium extraction with video analysis (${apifyData.videoDuration || 60} seconds of footage analyzed)`,
      missingInfo: [],
      requiresUserInput: false,
      videoAnalyzed: true
    };

    // If video data is available, enhance the mock
    if (apifyData.videoUrl) {
      mockRecipe.extractionNotes += `. Video URL available for enhanced extraction.`;
    }

    // Parse actual caption if available
    if (apifyData.caption && apifyData.caption.length > 20) {
      const lines = apifyData.caption.split('\n');
      const title = lines.find(line => line.length > 5 && !line.includes('INGREDIENT') && !line.includes('#'))?.trim();
      if (title) {
        mockRecipe.recipe.title = `Premium: ${title.replace(/[🍝🌟✨]/g, '').trim()}`;
      }
    }

    return mockRecipe;
  }

  preprocessInstagramCaption(caption) {
    if (!caption) return '';

    console.log('[RecipeAIExtractor] Preprocessing Instagram caption...');

    // Step 1: Clean up common Instagram formatting
    let processed = caption
      // Remove excessive emojis but keep food-related ones
      .replace(/[🔥💪💯🙌👍👌]/g, '')
      // Keep recipe-related emojis for context
      .replace(/([🍳🥞🍽️🥄🔥])/g, ' $1 ')
      // Normalize line breaks and spacing
      .replace(/\n+/g, '\n')
      .replace(/\s+/g, ' ')
      // Clean up common Instagram phrases
      .replace(/Recipe Below\s*[👇⬇️]+/gi, '\nRECIPE:')
      .replace(/By @\w+/gi, '')
      .replace(/recipe inspiration from @\w+/gi, '');

    // Step 2: Structure the content for better AI parsing
    const lines = processed.split('\n').map(line => line.trim()).filter(line => line.length > 0);

    let structuredContent = '';
    let inIngredients = false;
    let inInstructions = false;
    let title = '';

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // Detect title (usually first substantial line)
      if (!title && line.length > 5 && !line.startsWith('-') && !line.startsWith('#') && !line.includes('@')) {
        title = line.replace(/[🍳🥞🍽️🥄🔥]/g, '').trim();
        structuredContent += `RECIPE TITLE: ${title}\n\n`;
        continue;
      }

      // Detect ingredients section
      if (line.startsWith('-') || line.match(/^\d+\s*(g|ml|tsp|tbsp|cup|pound)/i)) {
        if (!inIngredients) {
          structuredContent += 'INGREDIENTS:\n';
          inIngredients = true;
          inInstructions = false;
        }
        structuredContent += `${line}\n`;
        continue;
      }

      // Detect cooking instructions
      if (line.match(/(bake|cook|mix|stir|heat|preheat)/i) && line.length > 10) {
        if (!inInstructions) {
          structuredContent += '\nINSTRUCTIONS:\n';
          inInstructions = true;
          inIngredients = false;
        }
        structuredContent += `${line}\n`;
        continue;
      }

      // Detect nutrition/serving info
      if (line.match(/(calories|protein|carb|fat|serves?)/i)) {
        structuredContent += `\nNUTRITION INFO: ${line}\n`;
        continue;
      }

      // Everything else as general content
      if (!line.startsWith('#') && !line.includes('@')) {
        structuredContent += `${line}\n`;
      }
    }

    console.log('[RecipeAIExtractor] Caption preprocessing complete:', {
      originalLength: caption.length,
      processedLength: structuredContent.length,
      hasTitle: !!title,
      hasIngredients: inIngredients,
      hasInstructions: inInstructions
    });

    return structuredContent.trim();
  }
}

module.exports = RecipeAIExtractor;