const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/auth');

// TTS Configuration
// Google Cloud TTS (ACTIVE - free tier, no abuse detection)
const GOOGLE_TTS_API_KEY = process.env.GOOGLE_TTS_API_KEY;
const GOOGLE_TTS_VOICE = 'en-US-Neural2-F'; // Female, warm, friendly

// ElevenLabs configuration (BACKUP - currently blocked by abuse detection)
// const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
// const ELEVENLABS_VOICE_ID = 'EXAVITQu4vr4xnSDxMaL'; // Bella voice (soft, warm female)

router.post('/ask', authMiddleware.authenticateToken, async (req, res) => {
  const requestId = Math.random().toString(36).substring(7);

  try {
    const { question, recipe, conversationHistory = [], inputMode = 'text' } = req.body;

    // Input validation
    if (!question || typeof question !== 'string') {
      return res.status(400).json({
        success: false,
        error: 'Question is required and must be a string'
      });
    }

    const trimmedQuestion = question.trim();

    if (trimmedQuestion.length < 3) {
      return res.status(400).json({
        success: false,
        error: 'Question is too short'
      });
    }

    if (trimmedQuestion.length > 500) {
      return res.status(400).json({
        success: false,
        error: 'Question is too long (max 500 characters)'
      });
    }

    if (!recipe?.title) {
      return res.status(400).json({
        success: false,
        error: 'Recipe information is required'
      });
    }

    console.log(`[AI-Chef:${requestId}] User: ${req.user.id}, Question: "${trimmedQuestion}"`);

    // Build context-aware prompt
    const ingredientsList = recipe.ingredients
      ?.map(i => `- ${i.amount || ''} ${i.unit || ''} ${i.name}`.trim())
      .join('\n') || 'No ingredients listed';

    const systemPrompt = `You are Chef Claude, a helpful AI cooking assistant. The user is cooking "${recipe.title}".

RECIPE CONTEXT:
Ingredients:
${ingredientsList}

Current Step: ${recipe.currentStep || 'Not specified'}

YOUR PERSONALITY:
- Friendly, encouraging, and conversational
- Speak like an experienced chef helping a friend
- Be specific to THIS recipe
- Reference the recipe ingredients when relevant

YOUR GUIDELINES:
- Answer concisely but completely (prefer 2-3 sentences, use more if needed for safety/clarity)
- For food safety questions (temperatures, doneness, spoilage), be thorough
- For substitution questions, suggest practical alternatives
- For timing questions, reference the recipe instructions
- If you don't know, admit it honestly
- Never make up measurements or temperatures

Respond naturally as if you're in the kitchen together.`;

    // Call OpenRouter with timeout
    const apiKey = process.env.OPENROUTER_API_KEY;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 45000); // 45 seconds - allow time for TTS

    try {
      const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://trackabite.app',
          'X-Title': 'Trackabite AI Chef',
        },
        body: JSON.stringify({
          model: 'google/gemini-2.0-flash-001',
          messages: [
            { role: 'system', content: systemPrompt },
            ...conversationHistory,
            { role: 'user', content: trimmedQuestion }
          ],
          max_tokens: 400,
          temperature: 0.7,
        }),
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (!response.ok) {
        if (response.status === 429) {
          return res.status(429).json({
            success: false,
            error: 'Too many requests. Please wait a moment.'
          });
        }
        throw new Error(`OpenRouter error: ${response.status}`);
      }

      const data = await response.json();
      const answer = data.choices?.[0]?.message?.content;

      if (!answer) {
        throw new Error('No answer from AI');
      }

      console.log(`[AI-Chef:${requestId}] Answer: "${answer.substring(0, 100)}..."`);

      // Generate TTS ONLY if input mode is 'voice'
      let audioUrl = null;
      if (inputMode === 'voice') {
        console.log(`[AI-Chef:${requestId}] Voice mode - generating TTS`);
        try {
        const ttsResponse = await fetch(
          `https://texttospeech.googleapis.com/v1/text:synthesize?key=${GOOGLE_TTS_API_KEY}`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              input: { text: answer },
              voice: {
                languageCode: 'en-US',
                name: GOOGLE_TTS_VOICE,
              },
              audioConfig: {
                audioEncoding: 'MP3',
                speakingRate: 1.05, // Slightly faster for natural conversation
                pitch: 0.0,
              },
            }),
          }
        );

        if (ttsResponse.ok) {
          const ttsData = await ttsResponse.json();
          audioUrl = `data:audio/mpeg;base64,${ttsData.audioContent}`;
          console.log(`[AI-Chef:${requestId}] ✅ Google TTS Success with ${GOOGLE_TTS_VOICE}`);
        } else {
          const errorBody = await ttsResponse.text();
          console.error(`[AI-Chef:${requestId}] ❌ Google TTS FAILED:`, {
            status: ttsResponse.status,
            statusText: ttsResponse.statusText,
            voiceName: GOOGLE_TTS_VOICE,
            apiKeyDefined: !!GOOGLE_TTS_API_KEY,
            errorBody: errorBody
          });
        }
        } catch (ttsError) {
          console.error(`[AI-Chef:${requestId}] Google TTS Error:`, ttsError);
          // Continue without audio - mobile will use expo-speech fallback
        }
      } else {
        console.log(`[AI-Chef:${requestId}] Text mode - skipping TTS generation`);
      }

      /* BACKUP: ElevenLabs TTS (currently blocked by abuse detection)
      // To switch back: Uncomment this section and comment out Google TTS above
      let audioUrl = null;
      try {
        const ttsResponse = await fetch(
          `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}`,
          {
            method: 'POST',
            headers: {
              'Accept': 'audio/mpeg',
              'xi-api-key': ELEVENLABS_API_KEY,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              text: answer,
              model_id: 'eleven_turbo_v2_5',
              voice_settings: {
                stability: 0.5,
                similarity_boost: 0.75,
                style: 0.5,
                use_speaker_boost: true,
              },
            }),
          }
        );

        if (ttsResponse.ok) {
          const audioBuffer = await ttsResponse.arrayBuffer();
          const base64Audio = Buffer.from(audioBuffer).toString('base64');
          audioUrl = `data:audio/mpeg;base64,${base64Audio}`;
          console.log(`[AI-Chef:${requestId}] ✅ ElevenLabs TTS Success`);
        } else {
          const errorBody = await ttsResponse.text();
          console.error(`[AI-Chef:${requestId}] ❌ ElevenLabs TTS FAILED:`, {
            status: ttsResponse.status,
            errorBody: errorBody
          });
        }
      } catch (ttsError) {
        console.error(`[AI-Chef:${requestId}] ElevenLabs TTS Error:`, ttsError);
      }
      */

      // Calculate costs
      const inputTokens = data.usage?.prompt_tokens || 0;
      const outputTokens = data.usage?.completion_tokens || 0;
      const llmCost = (inputTokens * 0.075 + outputTokens * 0.30) / 1_000_000;
      const ttsCost = audioUrl ? (answer.length * 16) / 1_000_000 : 0; // Google TTS: $16 per 1M chars (free tier: 1M chars/month)
      const totalCost = llmCost + ttsCost;

      console.log(`[AI-Chef:${requestId}] Cost: LLM=$${llmCost.toFixed(6)}, TTS=$${ttsCost.toFixed(6)}, Total=$${totalCost.toFixed(6)}`);

      res.json({
        success: true,
        answer: answer,
        audioUrl: audioUrl,
        usage: {
          inputTokens,
          outputTokens,
          totalTokens: inputTokens + outputTokens,
          cost: totalCost.toFixed(6),
        }
      });

    } catch (fetchError) {
      clearTimeout(timeout);

      if (fetchError.name === 'AbortError') {
        return res.status(504).json({
          success: false,
          error: 'Request timeout. Please try again.'
        });
      }
      throw fetchError;
    }

  } catch (error) {
    console.error(`[AI-Chef:${requestId}] Error:`, error);
    res.status(500).json({
      success: false,
      error: 'AI Chef temporarily unavailable. Please try again.'
    });
  }
});

// Speech-to-Text endpoint for voice input
router.post('/transcribe', authMiddleware.authenticateToken, async (req, res) => {
  const requestId = Math.random().toString(36).substring(7);

  try {
    const { audioBase64 } = req.body;

    // Input validation
    if (!audioBase64) {
      return res.status(400).json({
        success: false,
        error: 'Audio data required'
      });
    }

    console.log(`[STT:${requestId}] User: ${req.user.id}, Audio size: ${audioBase64.length} bytes`);

    // Convert base64 to buffer
    const audioBuffer = Buffer.from(audioBase64, 'base64');

    // Create FormData for OpenAI Whisper
    const FormData = require('form-data');
    const formData = new FormData();
    formData.append('file', audioBuffer, {
      filename: 'audio.m4a',
      contentType: 'audio/m4a',
    });
    formData.append('model', 'whisper-1');
    formData.append('language', 'en'); // Optimize for English

    // Call OpenAI Whisper API
    const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
        ...formData.getHeaders(),
      },
      body: formData,
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[STT:${requestId}] Whisper API error:`, response.status, errorText);
      throw new Error(`Whisper API error: ${response.status}`);
    }

    const data = await response.json();

    if (!data.text) {
      throw new Error('No transcript in response');
    }

    console.log(`[STT:${requestId}] Transcript: "${data.text}"`);

    res.json({
      success: true,
      transcript: data.text,
    });

  } catch (error) {
    console.error(`[STT:${requestId}] Error:`, error);
    res.status(500).json({
      success: false,
      error: 'Transcription failed. Please try again.',
    });
  }
});

module.exports = router;
