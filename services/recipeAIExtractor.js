const fetch = require('node-fetch');

class RecipeAIExtractor {
  constructor() {
    this.apiKey = process.env.OPENROUTER_API_KEY;
    // Primary model: Free Gemini 2.0 Flash (faster, newer)
    this.primaryModel = 'google/gemini-2.0-flash-exp:free';
    // Fallback model: Paid Gemini Flash 1.5 (reliable backup)
    this.fallbackModel = 'google/gemini-flash-1.5-8b';
    // Track usage for intelligent switching
    this.freeModelFailures = 0;
    this.freeModelSuccesses = 0;
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

      // Validate and clean the result (NO video boosting in Tier 1)
      const finalResult = this.validateAndTransformRecipe(result);

      // Tier 1 confidence boosting - ONLY for caption quality
      let confidenceBoost = 0;


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

  // TIER 2: Multi-Modal Video Analysis (Comprehensive & Expensive)
  async extractFromVideoData(apifyData) {
    console.log('[RecipeAIExtractor] Starting TIER 2 video analysis:', {
      hasVideo: !!apifyData.videoUrl,
      videoDuration: apifyData.videoDuration,
      viewCount: apifyData.viewCount,
      hasCaption: !!apifyData.caption,
      captionLength: apifyData.caption?.length || 0,
      imageCount: apifyData.images?.length || 0
    });

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

      // Include video URL and all available media for comprehensive analysis
      const mediaContent = apifyData.images || [];
      if (apifyData.videoUrl) {
        mediaContent.unshift({
          url: apifyData.videoUrl,
          type: 'video',
          duration: apifyData.videoDuration
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

      // Validate and clean the result with video analysis boost
      const finalResult = this.validateAndTransformRecipe(result);

      // Tier 2 confidence boosting - Enhanced for video analysis
      let confidenceBoost = 0;

      // Video data available (significant boost for Tier 2)
      if (apifyData.videoUrl && finalResult.confidence < 0.9) {
        confidenceBoost += 0.25; // Higher boost for video in Tier 2
        finalResult.videoConfidence = finalResult.confidence + confidenceBoost;
        console.log('[RecipeAIExtractor] TIER 2 confidence boosted for video analysis');
      }

      // High view count indicates popular/quality content
      if (apifyData.viewCount > 10000) {
        confidenceBoost += 0.1;
        console.log('[RecipeAIExtractor] TIER 2 confidence boosted for popular video');
      }

      // Apply confidence boost
      if (confidenceBoost > 0) {
        finalResult.confidence = Math.min(1.0, finalResult.confidence + confidenceBoost);
      }

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
TIER 2 VIDEO CONTEXT (COMPREHENSIVE ANALYSIS):
- A ${data.videoDuration}-second cooking video shows the complete preparation process
- Video contains visual cooking steps, techniques, timing, and ingredient reveals
- Ingredients are typically shown at the beginning of cooking videos
- Each scene change likely indicates a new cooking step or technique
- Final dish appearance validates recipe type and presentation
- Cooking sounds and visual cues provide technique information
- Video duration indicates cooking complexity and time requirements
` : ''}

TIER 2 EXTRACTION RULES (MULTI-MODAL):
1. VIDEO-FIRST ANALYSIS: Prioritize video content over caption when available
2. Tier 2 extraction should achieve HIGH CONFIDENCE (0.7+) due to comprehensive data
3. Video ingredients often more complete than caption ingredients
4. Visual cooking techniques override text descriptions when conflicting
5. Use video duration to estimate actual cooking and prep times
6. Scene changes indicate recipe progression and step count
7. Final dish appearance helps identify cuisine type and serving size
8. Popular videos (high view count) typically have reliable content
9. Comprehensive analysis should yield MORE COMPLETE recipes than Tier 1

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

    // Try free model first, with fallback to paid model
    return await this.callAIWithFallback(messages, prompt, images);
  }

  async callAIWithFallback(messages, prompt, images = []) {
    // Determine which model to try first based on recent success rates
    const freeModelSuccessRate = this.freeModelSuccesses / Math.max(1, this.freeModelSuccesses + this.freeModelFailures);
    const shouldUseFreeFirst = freeModelSuccessRate >= 0.3; // Use free if 30%+ success rate

    console.log('[RecipeAIExtractor] === MODEL SELECTION ===');
    console.log('[RecipeAIExtractor] Free model stats:', {
      successes: this.freeModelSuccesses,
      failures: this.freeModelFailures,
      successRate: freeModelSuccessRate.toFixed(2),
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
        this.freeModelFailures++;

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

    // Less severe penalties for missing data
    if (!recipe.title || recipe.title === 'Untitled Recipe') confidence -= 0.15; // was 0.2
    if (recipe.extendedIngredients.length === 0) confidence -= 0.2; // was 0.25
    if (!recipe.analyzedInstructions ||
        !recipe.analyzedInstructions[0] ||
        !recipe.analyzedInstructions[0].steps ||
        recipe.analyzedInstructions[0].steps.length === 0) confidence -= 0.2; // was 0.25

    // Boost confidence if we have at least some data
    if (recipe.extendedIngredients.length > 3) confidence += 0.1;
    if (recipe.analyzedInstructions?.[0]?.steps?.length > 3) confidence += 0.1;

    result.confidence = Math.max(0.35, Math.min(1.0, confidence)); // Minimum 35% confidence
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