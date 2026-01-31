const fetch = require('node-fetch');
const VideoProcessor = require('./videoProcessor');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const fs = require('fs').promises;
const path = require('path');
const os = require('os');

class MultiModalExtractor {
  constructor() {
    this.apiKey = process.env.OPENROUTER_API_KEY;
    this.videoProcessor = new VideoProcessor();

    // Google Gemini setup for direct video analysis
    this.geminiKey = process.env.GOOGLE_GEMINI_API_KEY;
    if (this.geminiKey && this.geminiKey !== 'your_google_gemini_api_key_here') {
      this.genAI = new GoogleGenerativeAI(this.geminiKey);
      this.geminiModel = this.genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });
      console.log('[MultiModal] Google Gemini API initialized for video analysis');
    } else {
      console.log('[MultiModal] Google Gemini API not configured - using fallback methods');
      this.geminiModel = null;
    }

    // Trust hierarchy weights for source prioritization
    this.trustWeights = {
      caption: 1.0,   // Primary source - highest trust
      visual: 0.8,    // Secondary source - high trust
      audio: 0.6      // Tertiary source - moderate trust
    };

    // Models for extraction (fallback)
    this.primaryModel = 'google/gemini-2.5-flash-lite';
    this.fallbackModel = 'google/gemini-2.5-flash';  // Paid fallback with video support

    // Ingredient aggregation service for deduplicating ingredients
    this.ingredientAggregationService = require('./ingredientAggregationService');
  }

  /**
   * Aggregate duplicate ingredients in a recipe's ingredient list
   * @param {Array} ingredients - Array of ingredient objects
   * @returns {Array} Deduplicated ingredients
   */
  aggregateIngredients(ingredients) {
    if (!ingredients || !Array.isArray(ingredients) || ingredients.length === 0) {
      return ingredients;
    }

    try {
      const aggregated = this.ingredientAggregationService.aggregateSingleRecipe(ingredients);
      console.log(`[MultiModal] Aggregated ingredients: ${ingredients.length} → ${aggregated.length}`);
      return aggregated;
    } catch (error) {
      console.warn('[MultiModal] Ingredient aggregation failed, using original:', error.message);
      return ingredients;
    }
  }

  /**
   * Main extraction method - analyzes all modalities simultaneously
   * @param {object} apifyData - Instagram post data from Apify
   * @returns {object} - Unified extraction result
   */
  async extractWithAllModalities(apifyData) {
    const startTime = Date.now();

    console.log('[MultiModal] Starting unified extraction:', {
      hasCaption: !!apifyData.caption,
      hasVideo: !!apifyData.videoUrl,
      videoDuration: apifyData.videoDuration,
      imageCount: apifyData.images?.length || 0,
      geminiAvailable: !!this.geminiModel
    });

    try {
      // Check video URL expiration first
      if (apifyData.videoUrlExpiry && Date.now() > apifyData.videoUrlExpiry) {
        console.warn('[MultiModal] Video URL expired, proceeding without video analysis');
        apifyData.videoUrl = null;
      }

      // PRIMARY PATH: Use Google Gemini for direct video analysis if available
      if (this.geminiModel && apifyData.videoUrl) {
        console.log('[MultiModal] Using Google Gemini for direct video analysis');
        try {
          const result = await this.analyzeVideoWithGemini(apifyData);
          if (result.success) {
            result.extractionMethod = 'gemini-video';
            result.processingTime = Date.now() - startTime;
            return result;
          }
        } catch (geminiError) {
          console.error('[MultiModal] Gemini video analysis failed, falling back:', geminiError.message);
        }
      }

      // FALLBACK PATH: Original multi-source extraction
      console.log('[MultiModal] Using fallback extraction method (caption + images)');

      // Log incoming Apify data for debugging
      console.log('[MultiModal] Apify data received:', {
        hasCaption: !!apifyData.caption,
        captionLength: apifyData.caption?.length || 0,
        imageCount: apifyData.images?.length || 0,
        firstImageUrl: apifyData.images?.[0]?.url?.substring(0, 100) || 'none',
        videoUrl: !!apifyData.videoUrl,
        author: apifyData.author?.username || 'unknown'
      });

      // Extract caption and static images
      const captionData = await this.extractCaptionData(apifyData);
      const imageData = await this.extractStaticImages(apifyData);

      console.log('[MultiModal] Fallback sources extracted:', {
        captionLength: captionData?.text?.length || 0,
        imageCount: imageData?.images?.length || 0,
        imageUrls: imageData?.images?.map(img => img.url?.substring(0, 50) + '...') || []
      });

      // Use OpenRouter for synthesis with images + caption
      const result = await this.synthesizeWithOpenRouter({
        caption: captionData,
        images: imageData,
        metadata: apifyData
      });

      // Add extraction metadata
      result.extractionMethod = 'fallback-multi-modal';
      result.processingTime = Date.now() - startTime;
      result.sourcesUsed = {
        caption: !!captionData?.text,
        images: imageData?.images?.length || 0,
        video: false
      };

      console.log('[MultiModal] Extraction complete:', {
        confidence: result.confidence,
        processingTime: result.processingTime,
        sourcesUsed: result.sourcesUsed
      });

      return result;

    } catch (error) {
      console.error('[MultiModal] Extraction failed:', {
        message: error.message,
        stack: error.stack,
        name: error.name
      });
      return {
        success: false,
        error: error.message,
        errorDetails: error.stack,
        extractionMethod: 'multi-modal',
        processingTime: Date.now() - startTime
      };
    }
  }

  /**
   * Extract and process caption data (enhanced with author comments)
   * @param {object} apifyData - Instagram post data
   * @returns {object} - Processed caption data including author comments
   */
  async extractCaptionData(apifyData) {
    // Clean and structure caption (graceful if empty)
    // IMPORTANT: Preserve newlines! They separate recipe sections (ingredients, steps, etc.)
    const cleanCaption = (apifyData.caption || '')
      .replace(/\n{3,}/g, '\n\n')    // Collapse 3+ newlines to 2 (keep structure)
      .replace(/[ \t]+/g, ' ')       // Only collapse spaces/tabs (NOT newlines)
      .trim();

    // Extract hashtags for context
    const hashtags = (apifyData.hashtags || []).filter(tag =>
      tag.toLowerCase().includes('recipe') ||
      tag.toLowerCase().includes('food') ||
      tag.toLowerCase().includes('cooking')
    );

    // NEW: Include author comments if available (often contains full recipe)
    const authorComments = apifyData.authorComments || [];
    const commentsText = authorComments.length > 0
      ? '\n\n--- AUTHOR\'S COMMENTS (Recipe details) ---\n' +
        authorComments.map(c => c.text).join('\n\n')
      : '';

    // Combine caption with author comments for AI extraction
    const combinedText = cleanCaption + commentsText;

    if (authorComments.length > 0) {
      console.log('[MultiModal] Including', authorComments.length, 'author comments in extraction');
      console.log('[MultiModal] Combined text length:', combinedText.length, '(caption:', cleanCaption.length, '+ comments)');
    }

    return {
      text: combinedText,
      captionOnly: cleanCaption,  // Keep original caption for reference
      hashtags: hashtags,
      length: combinedText.length,
      isEmpty: !cleanCaption && authorComments.length === 0,
      hasAuthorComments: authorComments.length > 0,
      authorCommentsCount: authorComments.length
    };
  }

  /**
   * Extract smart frames from video
   * @param {object} apifyData - Instagram post data
   * @returns {object} - Extracted frames data
   */
  async extractSmartFrames(apifyData) {
    // If no video, try to use existing images
    if (!apifyData.videoUrl) {
      console.log('[MultiModal] No video available, using static images if present');

      if (apifyData.images && apifyData.images.length > 0) {
        return {
          frames: apifyData.images.slice(0, 6).map((img, index) => ({
            url: img.url || img,
            timestamp: index,
            context: 'static_image'
          })),
          source: 'images'
        };
      }

      return { frames: [], source: 'none' };
    }

    // Use smart frame selection for 6 optimal frames
    const duration = apifyData.videoDuration || 30;
    const framePoints = this.getSmartFramePoints(duration);

    console.log('[MultiModal] Extracting frames at:', framePoints);

    // For now, we'll use the video URL directly with Gemini
    // Real frame extraction would use videoProcessor.extractFramesFromVideo
    // but that requires ffmpeg and video download

    // Simulate frame extraction with timestamps
    const frames = framePoints.map(timestamp => ({
      timestamp,
      context: this.getFrameContext(timestamp, duration),
      url: apifyData.videoUrl // Gemini can analyze video directly
    }));

    return {
      frames,
      source: 'video',
      duration,
      framePoints
    };
  }

  /**
   * Extract audio transcript from video
   * @param {object} apifyData - Instagram post data
   * @returns {object} - Audio transcript data
   */
  async extractAudioTranscript(apifyData) {
    if (!apifyData.videoUrl) {
      return { transcript: '', hasAudio: false };
    }

    console.log('[MultiModal] Extracting audio from video...');

    // For now, we'll let Gemini extract audio context from video
    // In production, could use Whisper API for dedicated transcription

    return {
      transcript: '', // Will be extracted by Gemini during synthesis
      hasAudio: true,
      duration: apifyData.videoDuration,
      requiresGeminiExtraction: true
    };
  }

  /**
   * Get smart frame points for optimal coverage
   * @param {number} duration - Video duration in seconds
   * @returns {Array<number>} - Array of timestamps to extract
   */
  getSmartFramePoints(duration) {
    // 6 optimal frames for comprehensive coverage
    const frames = [];

    // Critical moments
    frames.push(Math.min(3, duration * 0.05));  // Opening (ingredients display)
    frames.push(duration * 0.20);               // Preparation phase
    frames.push(duration * 0.40);               // Early cooking
    frames.push(duration * 0.60);               // Main cooking process
    frames.push(duration * 0.80);               // Assembly/plating
    frames.push(Math.max(duration * 0.95, duration - 2)); // Final dish

    // Round to nearest second and ensure within bounds
    return frames.map(t => Math.max(1, Math.min(Math.round(t), duration - 1)));
  }

  /**
   * Get context description for a frame based on timestamp
   * @param {number} timestamp - Frame timestamp
   * @param {number} duration - Total video duration
   * @returns {string} - Context description
   */
  getFrameContext(timestamp, duration) {
    const percentage = (timestamp / duration) * 100;

    if (percentage <= 10) return 'ingredient_display';
    if (percentage <= 25) return 'preparation';
    if (percentage <= 45) return 'early_cooking';
    if (percentage <= 65) return 'main_cooking';
    if (percentage <= 85) return 'assembly_plating';
    return 'final_presentation';
  }

  /**
   * Synthesize all sources with trust hierarchy
   * @param {object} sources - All extracted sources
   * @returns {object} - Unified recipe extraction
   */
  async synthesizeWithTrustHierarchy(sources) {
    const { caption, frames, audio, metadata } = sources;

    // Build comprehensive prompt
    const prompt = this.buildMultiModalPrompt(caption, frames, audio, metadata);

    // Prepare media content for Gemini
    const mediaContent = [];

    // Add video URL if available (Gemini can analyze directly)
    if (metadata.videoUrl && frames.source === 'video') {
      mediaContent.push({
        type: 'video',
        url: metadata.videoUrl,
        analysisHints: {
          extractAudio: audio.requiresGeminiExtraction,
          framesToAnalyze: frames.framePoints,
          focusOnTextOverlays: true
        }
      });
    }

    // Add static images if no video
    if (frames.source === 'images') {
      frames.frames.forEach(frame => {
        mediaContent.push({
          type: 'image',
          url: frame.url
        });
      });
    }

    // Call AI for synthesis
    const response = await this.callAI(prompt, mediaContent);

    // Parse and validate result
    const result = this.parseAIResponse(response);

    // Calculate confidence based on source agreement
    result.confidence = this.calculateConfidence(result, sources);

    return result;
  }

  /**
   * Build comprehensive multi-modal prompt
   */
  buildMultiModalPrompt(caption, frames, audio, metadata) {
    const primaryImageUrl = metadata.images?.[0]?.url || 'https://images.unsplash.com/photo-1546069901-ba9599a7e63c';

    return `You are performing MULTI-MODAL RECIPE EXTRACTION with THREE synchronized sources.

📝 SOURCE 1 - CAPTION (PRIMARY TRUST - Weight: 100%):
${caption.text || 'No caption available'}
Hashtags: ${caption.hashtags?.join(', ') || 'None'}

🎥 SOURCE 2 - VISUAL ANALYSIS (SECONDARY TRUST - Weight: 80%):
${frames.frames.length} key moments to analyze:
${frames.frames.map((f, i) => `
Frame ${i + 1} at ${f.timestamp}s (${f.context}):
- Analyze for ingredients, quantities, techniques
- Look for text overlays with measurements
- Identify cooking methods and tools
`).join('\n')}

🎤 SOURCE 3 - AUDIO ANALYSIS (TERTIARY TRUST - Weight: 60%):
${audio.requiresGeminiExtraction ?
  'Extract audio narration from video focusing on:' :
  'Audio transcript:'
}
- Spoken ingredients and quantities
- Verbal cooking instructions
- Temperature and timing mentions
- Technique explanations
${audio.transcript || ''}

CRITICAL TRUST HIERARCHY RULES:
1. CAPTION is the PRIMARY source - always trust it first
2. VISUAL evidence is SECONDARY - use to fill caption gaps
3. AUDIO is TERTIARY - only use for missing details

CONFLICT RESOLUTION:
- Caption says "2 cups flour" + Visual shows 3 cups → USE 2 CUPS (caption wins)
- Caption missing quantity + Visual shows 4 tomatoes → USE 4 (visual fills gap)
- Only audio mentions "bake 350°F" → USE 350°F (audio provides missing info)

EXTRACTION REQUIREMENTS:
1. Extract COMPLETE recipe with all ingredients and steps
2. Note which source provided each piece of information
3. Flag any conflicts between sources
4. Ensure all measurements are in decimal format (1/2 → 0.5)
5. Image URL must be: ${primaryImageUrl}

RETURN COMPREHENSIVE JSON:
{
  "success": true,
  "confidence": 0.0-1.0,
  "recipe": {
    "title": "Recipe name",
    "summary": "2-3 sentence description",
    "image": "${primaryImageUrl}",
    "extendedIngredients": [...],
    "analyzedInstructions": [...],
    "readyInMinutes": 30,
    "servings": 4,
    ...dietary flags
  },
  "sourceAttribution": {
    "ingredients": {"caption": [], "visual": [], "audio": []},
    "instructions": {"caption": [], "visual": [], "audio": []},
    "conflicts": []
  }
}`;
  }

  /**
   * Call AI API with content
   */
  async callAI(prompt, mediaContent = []) {
    const messages = [{
      role: 'user',
      content: [
        { type: 'text', text: prompt },
        ...mediaContent.map(media => {
          if (media.type === 'video') {
            return {
              type: 'image_url',
              image_url: {
                url: media.url,
                detail: 'high'
              }
            };
          }
          return {
            type: 'image_url',
            image_url: {
              url: media.url,
              detail: 'auto'
            }
          };
        })
      ]
    }];

    try {
      const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://fridgy.app',
          'X-Title': 'Fridgy Multi-Modal Import'
        },
        body: JSON.stringify({
          model: this.primaryModel,
          messages,
          response_format: { type: 'json_object' },
          temperature: 0.3,
          max_tokens: 3000
        })
      });

      const data = await response.json();

      if (!response.ok) {
        console.error('[MultiModal] API Error:', {
          status: response.status,
          statusText: response.statusText,
          error: data.error,
          fullData: JSON.stringify(data).substring(0, 500)
        });
        throw new Error(data.error?.message || `AI API error: ${response.status}`);
      }

      console.log('[MultiModal] API call successful, got response');
      return data.choices[0].message.content;

    } catch (error) {
      console.error('[MultiModal] AI call failed:', error);

      // Try fallback model on rate limit errors
      if (this.fallbackModel && (error.message?.includes('429') || error.message?.includes('rate') || error.message?.includes('Provider returned error'))) {
        console.log('[MultiModal] Primary model failed, trying fallback model:', this.fallbackModel);

        try {
          const fallbackResponse = await fetch('https://openrouter.ai/api/v1/chat/completions', {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${this.apiKey}`,
              'Content-Type': 'application/json',
              'HTTP-Referer': 'https://fridgy.app',
              'X-Title': 'Fridgy Multi-Modal Import'
            },
            body: JSON.stringify({
              model: this.fallbackModel,
              messages,
              response_format: { type: 'json_object' },
              temperature: 0.3,
              max_tokens: 3000
            })
          });

          const fallbackData = await fallbackResponse.json();

          if (!fallbackResponse.ok) {
            console.error('[MultiModal] Fallback model also failed:', fallbackData.error);
            throw new Error(fallbackData.error?.message || `Fallback AI API error: ${fallbackResponse.status}`);
          }

          console.log('[MultiModal] Fallback model successful');
          return fallbackData.choices[0].message.content;
        } catch (fallbackError) {
          console.error('[MultiModal] Fallback model failed:', fallbackError);
          throw fallbackError;
        }
      }

      throw error;
    }
  }

  /**
   * Parse and validate AI response
   */
  parseAIResponse(response) {
    try {
      console.log('[MultiModal] AI Response (first 500 chars):', response?.substring(0, 500));
      const result = JSON.parse(response);

      // Ensure required fields
      if (!result.recipe) {
        console.log('[MultiModal] WARNING: AI response missing recipe field');
        result.recipe = {};
        result.success = false;
      }

      // Set defaults
      result.recipe.title = result.recipe.title || 'Untitled Recipe';
      result.recipe.extendedIngredients = result.recipe.extendedIngredients || [];
      result.recipe.analyzedInstructions = result.recipe.analyzedInstructions || [{ name: '', steps: [] }];

      return result;

    } catch (error) {
      console.error('[MultiModal] Failed to parse AI response:', error);
      return {
        success: false,
        error: 'Failed to parse extraction result',
        recipe: null
      };
    }
  }

  /**
   * Calculate confidence based on source agreement
   */
  calculateConfidence(result, sources) {
    let confidence = 0.5; // Base confidence

    // Check if we have multiple sources
    const sourceCount = [
      sources.caption?.text,
      sources.frames?.frames?.length > 0,
      sources.audio?.hasAudio
    ].filter(Boolean).length;

    // More sources = higher confidence
    confidence += sourceCount * 0.15;

    // Check source attribution for agreement
    if (result.sourceAttribution) {
      const { ingredients, instructions } = result.sourceAttribution;

      // Agreement between sources boosts confidence
      if (ingredients.caption?.length > 0 && ingredients.visual?.length > 0) {
        confidence += 0.1; // Caption and visual agree
      }

      if (instructions.caption?.length > 0 && instructions.visual?.length > 0) {
        confidence += 0.1; // Instructions from multiple sources
      }

      // Conflicts reduce confidence
      if (result.sourceAttribution.conflicts?.length > 0) {
        confidence -= result.sourceAttribution.conflicts.length * 0.05;
      }
    }

    // Recipe completeness
    if (result.recipe?.extendedIngredients?.length > 5) confidence += 0.05;
    if (result.recipe?.analyzedInstructions?.[0]?.steps?.length > 5) confidence += 0.05;

    return Math.max(0.3, Math.min(1.0, confidence));
  }

  /**
   * Extract recipe from caption text ONLY (no video)
   * This forces the AI to focus entirely on the caption content
   * @param {string} caption - Instagram caption text
   * @param {object} apifyData - Full apify data for metadata
   * @returns {object} - Recipe extraction result
   */
  async extractFromCaptionOnly(caption, apifyData) {
    console.log('[MultiModal] Caption-only extraction starting...');
    console.log('[MultiModal] Caption length:', caption?.length || 0);
    console.log('[MultiModal] Caption preview:', caption?.substring(0, 300) + '...');

    if (!caption || caption.length < 50) {
      console.log('[MultiModal] Caption too short for extraction');
      return { success: false, hasCompleteRecipe: false };
    }

    const prompt = `Extract a COMPLETE recipe from this Instagram caption. This is TEXT ONLY - no images or video.

═══════════════════════════════════════════════════════════════
INSTAGRAM CAPTION:
═══════════════════════════════════════════════════════════════
${caption}
═══════════════════════════════════════════════════════════════

CRITICAL RULES:
1. The "original" field for each ingredient MUST be the EXACT text from the caption
   - If caption says "4 minced garlic cloves" → original: "4 minced garlic cloves"
   - Include ALL descriptors: minced, diced, chopped, boneless, skinless, etc.

2. Extract ALL instructions/steps - look for:
   - Numbered lists (1. 2. 3.)
   - Section headers like "assemble:", "for the sauce:", "instructions:"
   - Bullet points or dashes
   - Paragraph-style instructions

3. Extract nutrition if mentioned (calories, protein, carbs, fat)

Return this JSON:
{
  "title": "Recipe name",
  "summary": "Brief description",
  "extendedIngredients": [
    {
      "original": "EXACT text from caption including prep method",
      "name": "ingredient name",
      "amount": number,
      "unit": "unit"
    }
  ],
  "analyzedInstructions": [
    {
      "name": "",
      "steps": [
        {"number": 1, "step": "Full step text"},
        {"number": 2, "step": "Next step"},
        {"number": 3, "step": "Continue for ALL steps"}
      ]
    }
  ],
  "readyInMinutes": 30,
  "servings": 4,
  "nutrition": {
    "calories": number or null,
    "protein": number or null,
    "carbohydrates": number or null,
    "fat": number or null
  }
}`;

    try {
      // Use Gemini for text-only extraction (faster and no video processing needed)
      if (this.geminiModel) {
        const result = await this.geminiModel.generateContent(prompt);
        const response = await result.response;
        const text = response.text();

        console.log('[MultiModal] Caption-only Gemini response length:', text.length);

        const recipe = this.parseGeminiResponse(text);

        // Check if we got a complete recipe
        const hasIngredients = recipe.extendedIngredients?.length >= 3;
        const hasSteps = recipe.analyzedInstructions?.[0]?.steps?.length >= 2;
        const hasCompleteRecipe = hasIngredients && hasSteps;

        console.log('[MultiModal] Caption-only extraction result:', {
          ingredients: recipe.extendedIngredients?.length || 0,
          steps: recipe.analyzedInstructions?.[0]?.steps?.length || 0,
          hasCompleteRecipe
        });

        // Add image from apifyData
        const selectedImageUrl = this.selectBestRecipeImage(recipe, apifyData);
        recipe.image = selectedImageUrl;

        // Aggregate duplicate ingredients (e.g., "salt" appearing multiple times)
        recipe.extendedIngredients = this.aggregateIngredients(recipe.extendedIngredients);

        return {
          success: true,
          recipe: recipe,
          hasCompleteRecipe: hasCompleteRecipe,
          confidence: hasCompleteRecipe ? 0.9 : 0.5,
          extractionMethod: 'caption-only'
        };
      }

      return { success: false, hasCompleteRecipe: false };
    } catch (error) {
      console.error('[MultiModal] Caption-only extraction failed:', error.message);
      return { success: false, hasCompleteRecipe: false, error: error.message };
    }
  }

  /**
   * Analyze video directly with Google Gemini
   * @param {object} apifyData - Instagram post data with video URL
   * @returns {object} - Recipe extraction result
   */
  async analyzeVideoWithGemini(apifyData) {
    console.log('[MultiModal] Step 1: Starting extraction process');

    // STEP 1: First try caption-only extraction (more reliable for detailed ingredients)
    console.log('[MultiModal] Step 2: Trying caption-only extraction first...');
    const captionResult = await this.extractFromCaptionOnly(apifyData.caption, apifyData);

    if (captionResult.success && captionResult.hasCompleteRecipe) {
      console.log('[MultiModal] Caption extraction found recipe');
      console.log('[MultiModal] Ingredients found:', captionResult.recipe.extendedIngredients?.length);
      console.log('[MultiModal] Steps found:', captionResult.recipe.analyzedInstructions?.[0]?.steps?.length);

      // NEW: Check if we should force video analysis despite caption having "content"
      // This handles cases where caption is minimal but AI extracted generic/incomplete data
      const captionIsMinimal = !apifyData.caption || apifyData.caption.length < 200;
      const captionIndicatesVideoRecipe = /recipe.*(in|on).*(video|watch)|full.*recipe.*(video|watch)|watch.*(for|the).*recipe|instructions?.*(in|on).*video|check.*(video|link)|see.*video/i.test(apifyData.caption || '');

      const forceVideoAnalysis = captionIsMinimal || captionIndicatesVideoRecipe;

      if (forceVideoAnalysis) {
        console.log('[MultiModal] ⚠️ Caption is minimal or indicates video recipe - forcing video analysis');
        console.log('[MultiModal] Caption length:', apifyData.caption?.length || 0);
        console.log('[MultiModal] Indicates video recipe:', captionIndicatesVideoRecipe);
        // Continue to video analysis below
      } else {
        // Caption has substantial recipe content - use it (UNCHANGED BEHAVIOR)
        console.log('[MultiModal] ✅ Caption-only extraction successful - using caption data');
        return {
          success: true,
          recipe: captionResult.recipe,
          confidence: captionResult.confidence,
          sourcesUsed: {
            video: false,
            caption: true,
            images: false
          },
          extractionMethod: 'caption-only'
        };
      }
    }

    // STEP 2: Caption incomplete OR force video analysis - fall back to video
    console.log('[MultiModal] Proceeding with video analysis...');

    // Declare videoPath outside try so it's accessible in catch for paid fallback
    let videoPath = null;

    try {
      // Download video to temp file
      console.log('[MultiModal] Step 3: Downloading video from:', apifyData.videoUrl?.substring(0, 100) + '...');
      videoPath = await this.downloadVideoToTemp(apifyData.videoUrl);
      console.log('[MultiModal] Step 3: Video downloaded to:', videoPath);

      // Get file stats
      const stats = await fs.stat(videoPath);
      const fileSizeMB = (stats.size / (1024 * 1024)).toFixed(2);
      console.log('[MultiModal] Step 4: Video size:', fileSizeMB, 'MB');

      // Check size limit (1GB for Gemini)
      if (stats.size > 1024 * 1024 * 1024) {
        throw new Error('Video file too large (>1GB)');
      }

      // Read video file
      console.log('[MultiModal] Step 5: Reading video file...');
      const videoData = await fs.readFile(videoPath);
      const videoBase64 = videoData.toString('base64');

      // Prepare prompt
      const prompt = this.buildGeminiVideoPrompt(apifyData);

      // Send to Gemini
      console.log('[MultiModal] Step 6: Sending to Gemini API...');
      const result = await this.geminiModel.generateContent([
        {
          inlineData: {
            mimeType: 'video/mp4',
            data: videoBase64
          }
        },
        prompt
      ]);

      console.log('[MultiModal] Step 7: Gemini response received');

      // Parse response
      const response = await result.response;
      const text = response.text();
      console.log('[MultiModal] Step 8: Response text length:', text.length);

      // Parse JSON recipe
      const recipe = this.parseGeminiResponse(text);
      console.log('[MultiModal] Step 9: Recipe parsed successfully');

      // Apply image selection logic (duplicated from tier 1 for independence)
      const selectedImageUrl = this.selectBestRecipeImage(recipe, apifyData);
      recipe.image = selectedImageUrl;
      console.log('[MultiModal] Step 10: Selected image URL:', selectedImageUrl?.substring(0, 100) + '...');

      // Clean up temp file
      try {
        await fs.unlink(videoPath);
        console.log('[MultiModal] Step 11: Temp file cleaned up');
      } catch (cleanupError) {
        console.warn('[MultiModal] Failed to clean up temp file:', cleanupError.message);
      }

      // Determine extraction mode for logging
      const captionIsMinimal = !apifyData.caption || apifyData.caption.length < 200;
      const captionIndicatesVideoRecipe = /recipe.*(in|on).*(video|watch)|full.*recipe.*(video|watch)|watch.*(for|the).*recipe|instructions?.*(in|on).*video|check.*(video|link)|see.*video/i.test(apifyData.caption || '');
      const usedVideoFirstMode = captionIsMinimal || captionIndicatesVideoRecipe;

      // Aggregate duplicate ingredients
      recipe.extendedIngredients = this.aggregateIngredients(recipe.extendedIngredients);

      console.log('[MultiModal] ✅ Video analysis complete:', {
        extractionMode: usedVideoFirstMode ? 'video-primary' : 'video-supplementary',
        captionLength: apifyData.caption?.length || 0,
        ingredientsExtracted: recipe.extendedIngredients?.length || 0,
        stepsExtracted: recipe.analyzedInstructions?.[0]?.steps?.length || 0
      });

      return {
        success: true,
        recipe: recipe,
        confidence: 0.95, // High confidence for direct video analysis
        sourcesUsed: {
          video: true,
          videoAudioTranscribed: usedVideoFirstMode,
          videoTextExtracted: usedVideoFirstMode,
          caption: !!apifyData.caption,
          images: false
        },
        extractionMethod: usedVideoFirstMode ? 'gemini-video-multimodal' : 'gemini-video-supplementary'
      };

    } catch (error) {
      console.error('[MultiModal] Gemini video analysis failed:', error);

      // If rate limited, try paid model via OpenRouter
      const isRateLimited = error.message?.includes('429') ||
                            error.message?.includes('quota') ||
                            error.message?.includes('rate') ||
                            error.message?.includes('Too Many Requests');

      if (isRateLimited && videoPath) {
        console.log('[MultiModal] Free Gemini rate limited, trying paid model via OpenRouter...');

        try {
          const paidResult = await this.analyzeVideoWithOpenRouterPaid(videoPath, apifyData);

          // Clean up temp file after paid attempt
          try {
            await fs.unlink(videoPath);
            console.log('[MultiModal] Temp video file cleaned up after paid fallback');
          } catch (cleanupError) {
            console.warn('[MultiModal] Failed to clean up temp file:', cleanupError.message);
          }

          if (paidResult.success) {
            console.log('[MultiModal] ✅ Paid OpenRouter video analysis successful');
            return paidResult;
          }
        } catch (paidError) {
          console.error('[MultiModal] Paid OpenRouter also failed:', paidError.message);

          // Clean up temp file
          try { await fs.unlink(videoPath); } catch (e) {}
        }
      }

      throw error;
    }
  }

  /**
   * Select best recipe image (duplicated from tier 1 for independence)
   * @param {object} recipe - Recipe object from Gemini
   * @param {object} apifyData - Instagram data from Apify
   * @returns {string} - Selected image URL
   */
  selectBestRecipeImage(recipe, apifyData) {
    // Priority order for image selection (same logic as tier 1)
    const imageCandidates = [
      recipe.image,                               // AI-suggested image (highest priority)
      apifyData.images?.[0]?.url,                // Primary Instagram image
      apifyData.images?.[0],                     // Fallback to raw image data
      apifyData.author?.profilePic,              // Author profile pic as last resort
      'https://images.unsplash.com/photo-1546069901-ba9599a7e63c' // Default placeholder
    ];

    // Find first valid HTTP(S) URL
    for (const candidate of imageCandidates) {
      if (candidate && typeof candidate === 'string' && candidate.startsWith('http')) {
        return candidate;
      }
    }

    // Return placeholder if nothing else works
    return imageCandidates[imageCandidates.length - 1];
  }

  /**
   * Analyze video with OpenRouter paid model (fallback when free Gemini is rate limited)
   * @param {string} videoPath - Path to downloaded video file
   * @param {object} apifyData - Instagram/Facebook post data
   * @returns {object} - Recipe extraction result
   */
  async analyzeVideoWithOpenRouterPaid(videoPath, apifyData) {
    console.log('[MultiModal] Sending video to OpenRouter paid model...');

    try {
      // Read video as base64
      const videoData = await fs.readFile(videoPath);
      const videoBase64 = `data:video/mp4;base64,${videoData.toString('base64')}`;
      const fileSizeMB = (videoData.length / (1024 * 1024)).toFixed(2);
      console.log('[MultiModal] Video size for OpenRouter:', fileSizeMB, 'MB');

      // Build prompt (reuse the video-first prompt)
      const prompt = this.buildGeminiVideoPrompt(apifyData);

      // Call OpenRouter with video
      const messages = [{
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          {
            type: 'image_url',
            image_url: {
              url: videoBase64,
              detail: 'high'
            }
          }
        ]
      }];

      console.log('[MultiModal] Calling OpenRouter paid model: google/gemini-2.0-flash-lite-001');

      const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://fridgy.app',
          'X-Title': 'Fridgy Video Analysis (Paid Fallback)'
        },
        body: JSON.stringify({
          model: 'google/gemini-2.0-flash-lite-001',  // Paid model with video support
          messages,
          response_format: { type: 'json_object' },
          temperature: 0.3,
          max_tokens: 3000
        })
      });

      const data = await response.json();

      if (!response.ok) {
        console.error('[MultiModal] OpenRouter paid API error:', {
          status: response.status,
          error: data.error
        });
        throw new Error(data.error?.message || `OpenRouter API error: ${response.status}`);
      }

      console.log('[MultiModal] OpenRouter paid model response received');

      const responseText = data.choices[0].message.content;
      const recipe = this.parseGeminiResponse(responseText);

      // Apply image selection logic
      const selectedImageUrl = this.selectBestRecipeImage(recipe, apifyData);
      recipe.image = selectedImageUrl;

      // Aggregate duplicate ingredients
      recipe.extendedIngredients = this.aggregateIngredients(recipe.extendedIngredients);

      // Determine extraction mode for logging
      const captionIsMinimal = !apifyData.caption || apifyData.caption.length < 200;

      console.log('[MultiModal] ✅ OpenRouter paid video analysis complete:', {
        extractionMode: 'paid-video-fallback',
        captionLength: apifyData.caption?.length || 0,
        ingredientsExtracted: recipe.extendedIngredients?.length || 0,
        stepsExtracted: recipe.analyzedInstructions?.[0]?.steps?.length || 0
      });

      return {
        success: true,
        recipe: recipe,
        confidence: 0.90,  // Slightly lower confidence for fallback
        sourcesUsed: {
          video: true,
          videoAudioTranscribed: captionIsMinimal,
          videoTextExtracted: captionIsMinimal,
          caption: !!apifyData.caption,
          images: false
        },
        extractionMethod: 'openrouter-paid-video-fallback'
      };

    } catch (error) {
      console.error('[MultiModal] OpenRouter paid video analysis failed:', error);
      throw error;
    }
  }

  /**
   * Download video to temporary file
   * @param {string} videoUrl - URL of the video
   * @returns {string} - Path to downloaded video file
   */
  async downloadVideoToTemp(videoUrl) {
    const tempDir = os.tmpdir();
    const videoPath = path.join(tempDir, `instagram_video_${Date.now()}.mp4`);

    console.log('[MultiModal] Downloading video to temp:', videoPath);

    const response = await fetch(videoUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
        'Accept': 'video/mp4,video/*',
        'Referer': 'https://www.instagram.com/'
      }
    });

    if (!response.ok) {
      throw new Error(`Failed to download video: ${response.status} ${response.statusText}`);
    }

    const buffer = await response.buffer();
    await fs.writeFile(videoPath, buffer);

    return videoPath;
  }

  /**
   * Build prompt for Gemini video analysis
   * @param {object} apifyData - Instagram post data
   * @returns {string} - Prompt for Gemini
   */
  buildGeminiVideoPrompt(apifyData) {
    const caption = apifyData.caption || '';
    const hashtags = apifyData.hashtags?.join(', ') || 'None';

    // Include author comments if available (often contains full recipe!)
    const authorComments = apifyData.authorComments || [];
    const commentsSection = authorComments.length > 0
      ? '\n\n📝 AUTHOR\'S COMMENTS:\n' +
        authorComments.map(c => c.text).join('\n\n')
      : '';

    // Determine if caption is minimal - if so, prioritize video content
    const captionIsMinimal = caption.length < 200;
    const captionIndicatesVideoRecipe = /recipe.*(in|on).*(video|watch)|full.*recipe.*(video|watch)|watch.*(for|the).*recipe|instructions?.*(in|on).*video|check.*(video|link)|see.*video/i.test(caption);
    const prioritizeVideo = captionIsMinimal || captionIndicatesVideoRecipe;

    if (prioritizeVideo) {
      // MINIMAL CAPTION MODE: Video is the primary source
      return `You are extracting a recipe from a social media video. The caption is minimal or says "recipe in video" - THE RECIPE IS IN THE VIDEO.

═══════════════════════════════════════════════════════════════
🎤 VIDEO AUDIO - TRANSCRIBE EVERYTHING (PRIMARY SOURCE):
═══════════════════════════════════════════════════════════════
Listen to the ENTIRE video and transcribe ALL spoken content:
- ALL ingredients with exact quantities ("two cups of flour", "a tablespoon of olive oil")
- Verbal cooking instructions ("mix until combined", "bake for 25 minutes")
- Temperature and timing callouts ("preheat to 375 degrees", "let it rest for 10 minutes")
- Tips, techniques, and any recipe details mentioned

═══════════════════════════════════════════════════════════════
📺 ON-SCREEN TEXT (OCR) - READ ALL TEXT IN VIDEO (PRIMARY SOURCE):
═══════════════════════════════════════════════════════════════
Extract ALL text visible in the video frames:
- Ingredient lists shown on screen
- Recipe steps/instructions displayed as text overlays
- Measurements, temperatures, and timings shown
- Recipe title or name
- Any captions or subtitles

═══════════════════════════════════════════════════════════════
📝 CAPTION (Reference only - recipe is in video):
═══════════════════════════════════════════════════════════════
${caption || 'No caption'}
${commentsSection}
HASHTAGS: ${hashtags}

═══════════════════════════════════════════════════════════════

🔴 CRITICAL: The recipe IS in the video (audio or text overlays), NOT the caption.
- Transcribe EVERYTHING you hear in the video
- Extract ALL on-screen text
- Do NOT return empty/incomplete recipe
- If you hear ingredients spoken, include them ALL
- If you see text overlays with recipe steps, include them ALL

PRIORITY ORDER:
1. On-screen text overlays (most reliable)
2. Spoken audio from the video
3. Caption (only for supplementary info like title/author)

Return this JSON structure:
{
  "title": "Recipe name (from video title/audio/text)",
  "summary": "2-3 sentence description based on video content",
  "image": null,
  "extendedIngredients": [
    {
      "original": "Exact text from video audio or on-screen text",
      "name": "ingredient name",
      "amount": number,
      "unit": "measurement unit"
    }
  ],
  "analyzedInstructions": [
    {
      "name": "",
      "steps": [
        {"number": 1, "step": "Step from video audio or on-screen text"},
        {"number": 2, "step": "Next step..."},
        {"number": 3, "step": "Continue for ALL steps heard/seen in video"}
      ]
    }
  ],
  "readyInMinutes": 30,
  "servings": 4,
  "nutrition": {
    "calories": number or null,
    "protein": number or null,
    "carbohydrates": number or null,
    "fat": number or null
  },
  "vegetarian": false,
  "vegan": false,
  "glutenFree": false,
  "dairyFree": false
}

BEFORE RETURNING, VERIFY:
1. You transcribed ingredients from video audio OR extracted them from on-screen text
2. You transcribed cooking steps from video audio OR extracted them from on-screen text
3. Recipe is COMPLETE - if video shows a full recipe, your output should have full recipe
4. Do NOT return minimal/empty results - the recipe IS in this video`;
    }

    // FULL CAPTION MODE: Caption is the primary source (original behavior)
    return `You are extracting a recipe from an Instagram post. The caption contains the COMPLETE recipe.

═══════════════════════════════════════════════════════════════
📝 INSTAGRAM CAPTION (THIS IS YOUR PRIMARY DATA SOURCE):
═══════════════════════════════════════════════════════════════
${caption}
═══════════════════════════════════════════════════════════════

HASHTAGS: ${hashtags}
${commentsSection}

🔴 CRITICAL RULE FOR INGREDIENTS:
The "original" field MUST contain the COMPLETE text exactly as written in the caption.

EXAMPLES:
- Caption says "4 minced garlic cloves" → original: "4 minced garlic cloves" ✅
- Caption says "4 minced garlic cloves" → original: "4 garlic cloves" ❌ WRONG - missing "minced"
- Caption says "1 lb boneless skinless chicken thighs" → original: "1 lb boneless skinless chicken thighs" ✅
- Caption says "1 lb boneless skinless chicken thighs" → original: "1 lb chicken thighs" ❌ WRONG

Copy-paste the ingredient text from the caption into the "original" field. Include:
- Preparation methods: minced, diced, chopped, sliced, cubed, grated, etc.
- Descriptors: boneless, skinless, fresh, dried, low-sodium, etc.
- Specific types: Yukon gold potatoes, cherry tomatoes, Italian seasoning, etc.

🔴 CRITICAL RULE FOR INSTRUCTIONS:
If the caption has NUMBERED STEPS (1., 2., 3., etc.), preserve them EXACTLY AS WRITTEN:
- COUNT the numbered steps in the caption FIRST (e.g., steps 1-9 = 9 steps)
- Your output MUST have the SAME number of steps (9 steps in caption → 9 steps output)
- NEVER split a numbered step into multiple steps
- Keep ALL sentences from that numbered step TOGETHER as ONE step

EXAMPLE - Preserve long steps as ONE:
Caption: "3. Prepare all the veggies and aromatics. Make sure to wash and rinse bok choy thoroughly and drain. Strain rice cakes from water."
✅ CORRECT: ONE step: "Prepare all the veggies and aromatics. Make sure to wash and rinse bok choy thoroughly and drain. Strain rice cakes from water."
❌ WRONG: Three steps: "Prepare veggies" + "Wash bok choy" + "Strain rice cakes"

If NO numbered steps exist, look for "Instructions:", "Directions:", bullets, or action sentences.

🔴 NUTRITION (if mentioned in caption):
Look for: calories, protein, carbs, fat, macros, "per serving"

Use the video only to supplement information NOT in the caption.

Return this JSON structure:
{
  "title": "Recipe name from caption",
  "summary": "2-3 sentence description",
  "image": null,
  "extendedIngredients": [
    {
      "original": "COPY EXACT TEXT FROM CAPTION - include all descriptors like 'minced', 'diced', etc.",
      "name": "base ingredient name",
      "amount": number,
      "unit": "measurement unit"
    }
  ],
  "analyzedInstructions": [
    {
      "name": "",
      "steps": [
        {"number": 1, "step": "First step from caption"},
        {"number": 2, "step": "Second step from caption"},
        {"number": 3, "step": "Continue for ALL steps..."}
      ]
    }
  ],
  "readyInMinutes": 30,
  "servings": 4,
  "nutrition": {
    "calories": number or null,
    "protein": number or null,
    "carbohydrates": number or null,
    "fat": number or null
  },
  "vegetarian": false,
  "vegan": false,
  "glutenFree": false,
  "dairyFree": false
}

BEFORE RETURNING, VERIFY:
1. Each ingredient "original" field contains the FULL text from caption (including minced, diced, chopped, etc.)
2. Step count MATCHES the original recipe (if caption has 9 numbered steps, your output has exactly 9 steps)
3. Nutrition values are included if mentioned in caption
4. If caption had numbered steps (1., 2., 3., etc.), confirm you did NOT split any step into multiple steps`;
  }

  /**
   * Parse Gemini response into recipe object
   * @param {string} responseText - Text response from Gemini
   * @returns {object} - Parsed recipe object
   */
  parseGeminiResponse(responseText) {
    try {
      // Try to extract JSON from the response
      // Sometimes Gemini adds markdown formatting
      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error('No JSON found in Gemini response');
      }

      const recipe = JSON.parse(jsonMatch[0]);

      // Ensure required fields
      if (!recipe.title) {
        recipe.title = 'Untitled Recipe';
      }

      if (!recipe.extendedIngredients) {
        recipe.extendedIngredients = [];
      }

      if (!recipe.analyzedInstructions) {
        recipe.analyzedInstructions = [{ name: '', steps: [] }];
      }

      // Don't set default image here - let selectBestRecipeImage handle it
      // Image will be set after parsing in analyzeVideoWithGemini

      return recipe;

    } catch (error) {
      console.error('[MultiModal] Failed to parse Gemini response:', error);
      console.log('[MultiModal] Raw response:', responseText.substring(0, 500));
      throw new Error('Failed to parse recipe from Gemini response');
    }
  }

  /**
   * Extract static images (fallback when video not available)
   * @param {object} apifyData - Instagram post data
   * @returns {object} - Image data
   */
  async extractStaticImages(apifyData) {
    if (!apifyData.images || apifyData.images.length === 0) {
      return { images: [] };
    }

    // Take up to 6 images
    const images = apifyData.images.slice(0, 6).map((img, index) => ({
      url: img.url || img,
      index: index,
      context: `image_${index + 1}`
    }));

    return { images };
  }

  /**
   * Synthesize with OpenRouter (fallback method)
   * @param {object} sources - Caption and image sources
   * @returns {object} - Recipe extraction result
   */
  async synthesizeWithOpenRouter(sources) {
    const { caption, images, metadata } = sources;

    // Ensure images structure exists
    const safeImages = images || { images: [] };
    if (!safeImages.images) {
      safeImages.images = [];
    }

    // Log if no images available
    if (safeImages.images.length === 0) {
      console.warn('[MultiModal] No images available for synthesis, using caption-only extraction');
    }

    // Build prompt for OpenRouter
    const prompt = this.buildOpenRouterPrompt(caption, safeImages, metadata);

    // Prepare image content with null safety
    const imageContent = (safeImages.images || []).map(img => ({
      type: 'image_url',
      image_url: {
        url: img.url,
        detail: 'auto'
      }
    }));

    // Debug log the images being sent
    console.log('[MultiModal] Sending to OpenRouter:', {
      imageCount: imageContent.length,
      captionPreview: caption?.text?.substring(0, 100) || 'No caption',
      firstImageUrl: imageContent[0]?.image_url?.url?.substring(0, 100) || 'No images'
    });

    try {
      // Call OpenRouter API
      const response = await this.callAI(prompt, imageContent);
      const result = this.parseAIResponse(response);

      // Aggregate duplicate ingredients
      if (result.recipe?.extendedIngredients) {
        result.recipe.extendedIngredients = this.aggregateIngredients(result.recipe.extendedIngredients);
      }

      // Calculate confidence
      result.confidence = this.calculateFallbackConfidence(result, sources);

      return result;

    } catch (error) {
      console.error('[MultiModal] OpenRouter synthesis failed:', {
        error: error.message,
        stack: error.stack,
        imageCount: safeImages.images?.length || 0,
        captionLength: caption?.text?.length || 0
      });
      return {
        success: false,
        error: error.message,
        recipe: null
      };
    }
  }

  /**
   * Build prompt for OpenRouter fallback
   * @param {object} caption - Caption data
   * @param {object} images - Image data
   * @param {object} metadata - Post metadata
   * @returns {string} - Prompt for OpenRouter
   */
  buildOpenRouterPrompt(caption, images, metadata) {
    // Ensure images structure exists
    const imageCount = images?.images?.length || 0;

    // Note: caption.text already includes author comments from extractCaptionData()
    // but we add explicit instruction if comments were included
    const hasComments = caption?.hasAuthorComments || false;
    const commentsNote = hasComments
      ? '\n\n⚠️ IMPORTANT: The caption above includes AUTHOR\'S COMMENTS which often contain the full recipe with exact ingredients and instructions. Extract ALL details from both caption and comments!'
      : '';

    return `Extract a COMPLETE recipe from this Instagram post caption.

═══════════════════════════════════════════════════════════════
📝 CAPTION (PRIMARY DATA SOURCE):
═══════════════════════════════════════════════════════════════
${caption?.text || 'No caption available'}
═══════════════════════════════════════════════════════════════
${commentsNote}

IMAGES: ${imageCount} images provided (use only to supplement caption)

🔴 CRITICAL RULE FOR INGREDIENTS:
The "original" field MUST contain the COMPLETE text exactly as written in the caption.

EXAMPLES:
- Caption says "4 minced garlic cloves" → original: "4 minced garlic cloves" ✅
- Caption says "4 minced garlic cloves" → original: "4 garlic cloves" ❌ WRONG
- Caption says "1 lb boneless skinless chicken" → original: "1 lb boneless skinless chicken" ✅

Include ALL descriptors: minced, diced, chopped, boneless, skinless, fresh, etc.

🔴 CRITICAL RULE FOR INSTRUCTIONS:
If the caption has NUMBERED STEPS (1., 2., 3., etc.), preserve them EXACTLY AS WRITTEN:
- COUNT the numbered steps in the caption FIRST (e.g., steps 1-9 = 9 steps)
- Your output MUST have the SAME number of steps (9 steps in caption → 9 steps output)
- NEVER split a numbered step into multiple steps
- Keep ALL sentences from that numbered step TOGETHER as ONE step

EXAMPLE - Preserve long steps as ONE:
Caption: "3. Prepare all the veggies and aromatics. Make sure to wash and rinse bok choy thoroughly and drain. Strain rice cakes from water."
✅ CORRECT: ONE step: "Prepare all the veggies and aromatics. Make sure to wash and rinse bok choy thoroughly and drain. Strain rice cakes from water."
❌ WRONG: Three steps: "Prepare veggies" + "Wash bok choy" + "Strain rice cakes"

If NO numbered steps exist, look for "How to:", "Instructions:", or action sentences.

🔴 NUTRITION (if in caption):
Extract calories, protein, carbs, fat if mentioned.

Return this JSON:
{
  "success": true,
  "recipe": {
    "title": "Recipe name",
    "summary": "2-3 sentence description",
    "extendedIngredients": [
      {
        "original": "EXACT TEXT from caption with ALL descriptors (minced, diced, etc.)",
        "name": "base ingredient",
        "amount": 1.0,
        "unit": "cup"
      }
    ],
    "analyzedInstructions": [
      {
        "name": "",
        "steps": [
          {"number": 1, "step": "First step"},
          {"number": 2, "step": "Second step"},
          {"number": 3, "step": "Continue for ALL steps"}
        ]
      }
    ],
    "readyInMinutes": 45,
    "servings": 4,
    "nutrition": {
      "calories": number or null,
      "protein": number or null,
      "carbohydrates": number or null,
      "fat": number or null
    }
  }
}

VERIFY BEFORE RETURNING:
1. Each "original" field has FULL text including prep methods (minced, diced, etc.)
2. Step count MATCHES the original recipe (if caption has 9 numbered steps, your output has exactly 9 steps)
3. Amounts in decimal format (1/2 → 0.5)
4. If caption had numbered steps (1., 2., 3., etc.), confirm you did NOT split any step into multiple steps`;
  }

  /**
   * Calculate confidence for fallback method
   * @param {object} result - Extraction result
   * @param {object} sources - Available sources
   * @returns {number} - Confidence score
   */
  calculateFallbackConfidence(result, sources) {
    let confidence = 0.5; // Base confidence

    // Has caption
    if (sources.caption?.text) {
      confidence += 0.2;
    }

    // Has images
    const imageCount = sources.images?.images?.length || 0;
    if (imageCount > 0) {
      confidence += 0.1 * Math.min(imageCount, 3);
    }

    // Has complete recipe
    if (result.recipe?.extendedIngredients?.length > 0 &&
        result.recipe?.analyzedInstructions?.[0]?.steps?.length > 0) {
      confidence += 0.1;
    }

    return Math.min(confidence, 0.9); // Cap at 0.9 for fallback
  }
}

module.exports = MultiModalExtractor;