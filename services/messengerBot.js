/**
 * Facebook Messenger Bot Service
 * Handles incoming messages, recipe extraction, and responses
 */

const fetch = require('node-fetch');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const facebookService = require('./apifyFacebookService');
const MultiModalExtractor = require('./multiModalExtractor');
const NutritionExtractor = require('./nutritionExtractor');
const NutritionAnalysisService = require('./nutritionAnalysisService');
const { sanitizeRecipeData } = require('../middleware/validation');

class MessengerBot {
  constructor() {
    this.supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY
    );

    this.pageAccessToken = process.env.MESSENGER_PAGE_ACCESS_TOKEN;
    this.appSecret = process.env.MESSENGER_APP_SECRET;
    this.graphApiVersion = 'v18.0';

    // Initialize extractors
    this.multiModalExtractor = new MultiModalExtractor();
    this.nutritionExtractor = new NutritionExtractor();
    this.nutritionAnalysis = new NutritionAnalysisService();

    // Link token expiry (10 minutes)
    this.linkTokenExpiry = 10 * 60 * 1000;
  }

  /**
   * Verify webhook signature from Facebook
   */
  verifySignature(signature, body) {
    if (!this.appSecret) {
      console.warn('[MessengerBot] App secret not configured - skipping signature verification');
      return true;
    }

    const expectedSignature = crypto
      .createHmac('sha256', this.appSecret)
      .update(body)
      .digest('hex');

    return signature === `sha256=${expectedSignature}`;
  }

  /**
   * Handle incoming webhook event from Facebook
   */
  async handleEvent(event) {
    const senderPsid = event.sender?.id;

    if (!senderPsid) {
      console.log('[MessengerBot] No sender PSID in event');
      return;
    }

    console.log('[MessengerBot] Received event from PSID:', senderPsid);

    // Handle postback events (button clicks)
    if (event.postback) {
      await this.handlePostback(senderPsid, event.postback);
      return;
    }

    // Handle message events
    if (event.message) {
      await this.handleMessage(senderPsid, event.message);
      return;
    }
  }

  /**
   * Handle postback events (button clicks)
   */
  async handlePostback(psid, postback) {
    console.log('[MessengerBot] Handling postback:', postback.payload);

    // Currently no postback handlers needed
    // Future: could handle "Get Started" button, etc.
  }

  /**
   * Handle incoming messages
   */
  async handleMessage(psid, message) {
    console.log('[MessengerBot] Handling message from:', psid);

    try {
      // Check if user is linked
      const connection = await this.getConnection(psid);

      if (!connection) {
        console.log('[MessengerBot] User not linked, sending link message');
        await this.sendLinkAccountMessage(psid);
        return;
      }

      console.log('[MessengerBot] User linked to account:', connection.user_id);

      // Update last message timestamp
      await this.updateLastMessage(psid);

      // Extract URL from message
      const url = this.extractUrl(message);

      if (!url) {
        await this.sendMessage(psid, "Please share a Facebook recipe post with me! Just tap 'Share' on any recipe post and send it here.");
        return;
      }

      console.log('[MessengerBot] Extracted URL:', url);

      // Check if it's a Facebook URL
      if (!facebookService.isFacebookUrl(url)) {
        await this.sendMessage(psid, "That doesn't look like a Facebook link. Please share a recipe post from Facebook.");
        return;
      }

      // Send processing message
      await this.sendMessage(psid, "Extracting recipe... This takes 10-15 seconds.");

      // Extract and save recipe
      const result = await this.extractAndSaveRecipe(url, connection.user_id);

      if (result.success) {
        await this.sendRecipeConfirmation(psid, result.recipe);
      } else {
        await this.sendErrorMessage(psid, result.error);
      }

    } catch (error) {
      console.error('[MessengerBot] Error handling message:', error);
      await this.sendMessage(psid, "Something went wrong. Please try again later.");
    }
  }

  /**
   * Extract URL from message (attachments or text)
   */
  extractUrl(message) {
    // Check attachments first (shared posts come as attachments)
    if (message.attachments) {
      for (const attachment of message.attachments) {
        // Shared posts have type 'fallback' with URL
        if (attachment.type === 'fallback' && attachment.url) {
          return attachment.url;
        }
        // Also check payload for URL
        if (attachment.payload?.url) {
          return attachment.payload.url;
        }
      }
    }

    // Check text for URL
    if (message.text) {
      const urlMatch = message.text.match(/https?:\/\/[^\s]+/);
      if (urlMatch) {
        return urlMatch[0];
      }
    }

    return null;
  }

  /**
   * Extract recipe and save to user's account
   */
  async extractAndSaveRecipe(url, userId) {
    try {
      console.log('[MessengerBot] Starting recipe extraction for user:', userId);

      // Extract with Apify
      const apifyData = await facebookService.extractFromUrl(url, userId);

      if (!apifyData.success) {
        console.log('[MessengerBot] Apify extraction failed:', apifyData.error);
        return {
          success: false,
          error: apifyData.limitExceeded
            ? 'You\'ve reached your monthly import limit. Upgrade to Premium for more!'
            : apifyData.error || 'Could not extract content from this post'
        };
      }

      console.log('[MessengerBot] Apify extraction successful');

      // Use multi-modal extractor
      const result = await this.multiModalExtractor.extractWithAllModalities(apifyData);

      if (!result.success || !result.recipe) {
        console.log('[MessengerBot] Multi-modal extraction failed');
        return {
          success: false,
          error: 'Could not find a recipe in this post. Make sure it contains ingredients and instructions.'
        };
      }

      console.log('[MessengerBot] Multi-modal extraction successful');

      // Download and store image
      const tempRecipeId = `messenger-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
      let permanentImageUrl = null;
      const primaryImageUrl = result.recipe.image || apifyData.images?.[0]?.url;

      if (primaryImageUrl && primaryImageUrl.startsWith('http')) {
        permanentImageUrl = await facebookService.downloadFacebookImage(
          primaryImageUrl,
          tempRecipeId,
          userId
        );
      }

      const PLACEHOLDER_IMAGE = 'https://images.unsplash.com/photo-1546069901-ba9599a7e63c?w=400';
      const finalImageUrl = permanentImageUrl || PLACEHOLDER_IMAGE;

      // Sanitize recipe data
      const sanitizedRecipe = sanitizeRecipeData({
        ...result.recipe,
        source_type: 'facebook',
        source_url: url,
        source_author: apifyData.author?.username,
        source_author_image: apifyData.author?.profilePic,
        image: finalImageUrl
      });

      // Get nutrition
      try {
        let nutritionData = null;
        const extractedNutrition = await this.nutritionExtractor.extractFromCaption(apifyData.caption);

        if (extractedNutrition && extractedNutrition.found) {
          nutritionData = this.nutritionExtractor.formatNutritionData(extractedNutrition);
        } else {
          nutritionData = await this.nutritionAnalysis.analyzeRecipeNutrition(sanitizedRecipe);
        }

        sanitizedRecipe.nutrition = nutritionData;
      } catch (nutritionError) {
        console.error('[MessengerBot] Nutrition processing failed:', nutritionError.message);
        sanitizedRecipe.nutrition = null;
      }

      // Save to database
      const savedRecipe = await this.saveRecipe(sanitizedRecipe, userId);

      if (!savedRecipe) {
        return {
          success: false,
          error: 'Failed to save recipe to your account'
        };
      }

      console.log('[MessengerBot] Recipe saved with ID:', savedRecipe.id);

      return {
        success: true,
        recipe: savedRecipe
      };

    } catch (error) {
      console.error('[MessengerBot] Extract and save error:', error);
      return {
        success: false,
        error: 'Something went wrong while processing the recipe'
      };
    }
  }

  /**
   * Save recipe to database
   */
  async saveRecipe(recipeData, userId) {
    try {
      const newRecipe = {
        user_id: userId,
        source_type: recipeData.source_type || 'facebook',
        title: recipeData.title || 'Untitled Recipe',
        summary: recipeData.summary || recipeData.description || '',
        image: recipeData.image || null,
        source_url: recipeData.source_url || null,
        source_author: recipeData.source_author || null,
        source_author_image: recipeData.source_author_image || null,

        extendedIngredients: recipeData.extendedIngredients || [],
        analyzedInstructions: recipeData.analyzedInstructions || [],

        readyInMinutes: recipeData.readyInMinutes || null,
        cookingMinutes: recipeData.cookingMinutes || null,
        servings: recipeData.servings || 4,

        vegetarian: recipeData.vegetarian || false,
        vegan: recipeData.vegan || false,
        glutenFree: recipeData.glutenFree || false,
        dairyFree: recipeData.dairyFree || false,

        cuisines: recipeData.cuisines || [],
        dishTypes: recipeData.dishTypes || [],
        nutrition: recipeData.nutrition || null,

        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      };

      const { data, error } = await this.supabase
        .from('saved_recipes')
        .insert(newRecipe)
        .select()
        .single();

      if (error) {
        console.error('[MessengerBot] Save recipe error:', error);
        return null;
      }

      // Increment usage counter
      await this.incrementUsageCounter(userId);

      return data;

    } catch (error) {
      console.error('[MessengerBot] Save recipe error:', error);
      return null;
    }
  }

  /**
   * Increment usage counter for uploaded recipes
   */
  async incrementUsageCounter(userId) {
    try {
      const currentMonth = new Date().toISOString().slice(0, 7);

      await this.supabase.rpc('increment_usage_counter', {
        p_user_id: userId,
        p_counter_type: 'uploaded_recipes',
        p_month: currentMonth
      });
    } catch (error) {
      console.error('[MessengerBot] Failed to increment usage counter:', error);
      // Don't fail the save if counter increment fails
    }
  }

  /**
   * Get messenger connection for a PSID
   */
  async getConnection(psid) {
    const { data, error } = await this.supabase
      .from('messenger_connections')
      .select('*')
      .eq('facebook_psid', psid)
      .single();

    if (error && error.code !== 'PGRST116') {
      console.error('[MessengerBot] Get connection error:', error);
    }

    return data;
  }

  /**
   * Update last message timestamp
   */
  async updateLastMessage(psid) {
    await this.supabase
      .from('messenger_connections')
      .update({ last_message_at: new Date().toISOString() })
      .eq('facebook_psid', psid);
  }

  /**
   * Generate a link token for account linking
   */
  generateLinkToken(psid) {
    const token = crypto.randomBytes(32).toString('hex');
    return token;
  }

  /**
   * Store link token in database
   */
  async storeLinkToken(psid, token) {
    const expiresAt = new Date(Date.now() + this.linkTokenExpiry).toISOString();

    await this.supabase
      .from('messenger_link_tokens')
      .insert({
        facebook_psid: psid,
        token: token,
        expires_at: expiresAt
      });

    return token;
  }

  /**
   * Validate a link token
   */
  async validateLinkToken(psid, token) {
    const { data, error } = await this.supabase
      .from('messenger_link_tokens')
      .select('*')
      .eq('facebook_psid', psid)
      .eq('token', token)
      .eq('used', false)
      .gt('expires_at', new Date().toISOString())
      .single();

    return !!data;
  }

  /**
   * Mark link token as used and create connection
   */
  async completeLinking(psid, token, userId) {
    // Mark token as used
    await this.supabase
      .from('messenger_link_tokens')
      .update({ used: true })
      .eq('facebook_psid', psid)
      .eq('token', token);

    // Create connection
    const { data, error } = await this.supabase
      .from('messenger_connections')
      .upsert({
        user_id: userId,
        facebook_psid: psid,
        linked_at: new Date().toISOString()
      }, {
        onConflict: 'facebook_psid'
      })
      .select()
      .single();

    if (error) {
      console.error('[MessengerBot] Complete linking error:', error);
      return false;
    }

    // Send confirmation message to Messenger
    await this.sendMessage(psid, "You're connected! From now on, just share any Facebook recipe post to me and I'll save it to your Trackabite account.");

    return true;
  }

  /**
   * Send a simple text message
   */
  async sendMessage(psid, text) {
    if (!this.pageAccessToken) {
      console.error('[MessengerBot] Page access token not configured');
      return false;
    }

    try {
      const response = await fetch(
        `https://graph.facebook.com/${this.graphApiVersion}/me/messages?access_token=${this.pageAccessToken}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            recipient: { id: psid },
            message: { text }
          })
        }
      );

      const data = await response.json();

      if (data.error) {
        console.error('[MessengerBot] Send message error:', data.error);
        return false;
      }

      return true;

    } catch (error) {
      console.error('[MessengerBot] Send message error:', error);
      return false;
    }
  }

  /**
   * Send account linking message with button
   */
  async sendLinkAccountMessage(psid) {
    if (!this.pageAccessToken) {
      console.error('[MessengerBot] Page access token not configured');
      return false;
    }

    // Generate and store link token
    const token = this.generateLinkToken(psid);
    await this.storeLinkToken(psid, token);

    const frontendUrl = process.env.FRONTEND_URL || 'https://trackabite.com';
    const linkUrl = `${frontendUrl}/link-messenger?psid=${psid}&token=${token}`;

    try {
      const response = await fetch(
        `https://graph.facebook.com/${this.graphApiVersion}/me/messages?access_token=${this.pageAccessToken}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            recipient: { id: psid },
            message: {
              attachment: {
                type: 'template',
                payload: {
                  template_type: 'button',
                  text: "Welcome to Trackabite!\n\nI can save Facebook recipes directly to your account. Just share any recipe post with me!\n\nFirst, let's link your account:",
                  buttons: [{
                    type: 'web_url',
                    url: linkUrl,
                    title: 'Link My Account',
                    webview_height_ratio: 'tall'
                  }]
                }
              }
            }
          })
        }
      );

      const data = await response.json();

      if (data.error) {
        console.error('[MessengerBot] Send link message error:', data.error);
        return false;
      }

      return true;

    } catch (error) {
      console.error('[MessengerBot] Send link message error:', error);
      return false;
    }
  }

  /**
   * Send recipe confirmation with button to open in app
   */
  async sendRecipeConfirmation(psid, recipe) {
    if (!this.pageAccessToken) {
      console.error('[MessengerBot] Page access token not configured');
      return false;
    }

    const frontendUrl = process.env.FRONTEND_URL || 'https://trackabite.com';
    const recipeUrl = `${frontendUrl}/recipes/${recipe.id}`;

    const text = `Recipe saved!\n\n${recipe.title}${recipe.source_author ? `\nby ${recipe.source_author}` : ''}${recipe.readyInMinutes ? `\n\n${recipe.readyInMinutes} min` : ''}${recipe.servings ? ` | ${recipe.servings} servings` : ''}`;

    try {
      const response = await fetch(
        `https://graph.facebook.com/${this.graphApiVersion}/me/messages?access_token=${this.pageAccessToken}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            recipient: { id: psid },
            message: {
              attachment: {
                type: 'template',
                payload: {
                  template_type: 'button',
                  text: text,
                  buttons: [{
                    type: 'web_url',
                    url: recipeUrl,
                    title: 'Open in Trackabite',
                    webview_height_ratio: 'tall'
                  }]
                }
              }
            }
          })
        }
      );

      const data = await response.json();

      if (data.error) {
        console.error('[MessengerBot] Send confirmation error:', data.error);
        // Fall back to simple text message
        await this.sendMessage(psid, `Recipe saved! "${recipe.title}" has been added to your Trackabite account.`);
      }

      return true;

    } catch (error) {
      console.error('[MessengerBot] Send confirmation error:', error);
      // Fall back to simple text message
      await this.sendMessage(psid, `Recipe saved! "${recipe.title}" has been added to your Trackabite account.`);
      return false;
    }
  }

  /**
   * Send error message
   */
  async sendErrorMessage(psid, error) {
    const message = `I couldn't extract a recipe from that post.\n\nThis might be because:\n- The post doesn't contain a recipe\n- It's a private post I can't access\n- The post format isn't supported\n\nTry sharing a different recipe post!`;

    await this.sendMessage(psid, message);
  }

  /**
   * Get connection status for a user (for settings page)
   */
  async getConnectionForUser(userId) {
    const { data, error } = await this.supabase
      .from('messenger_connections')
      .select('*')
      .eq('user_id', userId)
      .single();

    if (error && error.code !== 'PGRST116') {
      console.error('[MessengerBot] Get user connection error:', error);
    }

    return data;
  }

  /**
   * Disconnect messenger for a user
   */
  async disconnectUser(userId) {
    const { error } = await this.supabase
      .from('messenger_connections')
      .delete()
      .eq('user_id', userId);

    if (error) {
      console.error('[MessengerBot] Disconnect error:', error);
      return false;
    }

    return true;
  }
}

module.exports = new MessengerBot();
