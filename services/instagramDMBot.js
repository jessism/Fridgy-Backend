/**
 * Instagram DM Bot Service
 * Handles incoming DM messages, recipe extraction, and responses
 * Based on messengerBot.js pattern for Facebook Messenger
 */

const fetch = require('node-fetch');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const ApifyInstagramService = require('./apifyInstagramService');
const MultiModalExtractor = require('./multiModalExtractor');
const NutritionExtractor = require('./nutritionExtractor');
const NutritionAnalysisService = require('./nutritionAnalysisService');
const { sanitizeRecipeData } = require('../middleware/validation');

// Friendly extraction messages - randomly selected for personality
const EXTRACTING_MESSAGES = [
  (name) => name ? `Ooh, this looks delicious, ${name}! Let me grab that recipe for you... ` : "Ooh, this looks delicious! Let me grab that recipe for you... ",
  (name) => name ? `On it, ${name}! Give me a sec to work my magic...` : "On it! Give me a sec to work my magic...",
  (name) => name ? `Yum! Saving this one for you now, ${name}...` : "Yum! Saving this one for you now...",
  (name) => name ? `Chef's kiss, ${name}! Snagging this recipe...` : "Chef's kiss! Snagging this recipe...",
  (name) => name ? `Adding to your collection, ${name}... (I'm a little jealous tbh)` : "Adding to your collection... (I'm a little jealous tbh)",
  (name) => name ? `Great pick, ${name}! Extracting the goods now...` : "Great pick! Extracting the goods...",
  (name) => name ? `Love this choice, ${name}! Saving it to your recipes...` : "Love this choice! Saving it to your recipes...",
  (name) => name ? `Nice find, ${name}! Let me save this for you...` : "Nice find! Let me save this for you...",
  (name) => name ? `Good taste, ${name}! Getting this recipe ready for you...` : "Good taste! Getting this recipe ready for you..."
];

class InstagramDMBot {
  constructor() {
    this.supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY
    );

    // Instagram uses the same page access token as Facebook Messenger
    // (they're managed through the same Meta Business Suite)
    this.pageAccessToken = process.env.INSTAGRAM_PAGE_ACCESS_TOKEN || process.env.MESSENGER_PAGE_ACCESS_TOKEN;
    this.appSecret = process.env.INSTAGRAM_APP_SECRET || process.env.MESSENGER_APP_SECRET;
    this.graphApiVersion = 'v18.0';

    // Initialize extractors
    this.apifyService = new ApifyInstagramService();
    this.multiModalExtractor = new MultiModalExtractor();
    this.nutritionExtractor = new NutritionExtractor();
    this.nutritionAnalysis = new NutritionAnalysisService();

    // Link token expiry (10 minutes)
    this.linkTokenExpiry = 10 * 60 * 1000;
  }

  /**
   * Verify webhook signature from Meta
   */
  verifySignature(signature, body) {
    if (!this.appSecret) {
      console.warn('[InstagramDMBot] App secret not configured - skipping signature verification');
      return true;
    }

    const expectedSignature = crypto
      .createHmac('sha256', this.appSecret)
      .update(body)
      .digest('hex');

    return signature === `sha256=${expectedSignature}`;
  }

  /**
   * Check if URL is an Instagram URL
   */
  isInstagramUrl(url) {
    if (!url) return false;
    return /instagram\.com|instagr\.am/i.test(url);
  }

  /**
   * Get user's first name from the users table
   */
  async getUserName(userId) {
    try {
      const { data, error } = await this.supabase
        .from('users')
        .select('first_name')
        .eq('id', userId)
        .single();

      if (error || !data) return null;
      return data.first_name || null;
    } catch (error) {
      console.error('[InstagramDMBot] Get user name error:', error);
      return null;
    }
  }

  /**
   * Handle incoming webhook event from Instagram
   */
  async handleEvent(event) {
    const senderIgsid = event.sender?.id;

    if (!senderIgsid) {
      console.log('[InstagramDMBot] No sender IGSID in event');
      return;
    }

    console.log('[InstagramDMBot] Received event from IGSID:', senderIgsid);

    // Handle postback events (button clicks)
    if (event.postback) {
      await this.handlePostback(senderIgsid, event.postback);
      return;
    }

    // Handle message events
    if (event.message) {
      await this.handleMessage(senderIgsid, event.message);
      return;
    }
  }

  /**
   * Handle postback events (button clicks)
   */
  async handlePostback(igsid, postback) {
    console.log('[InstagramDMBot] Handling postback:', postback.payload);
    // Future: could handle "Get Started" button, etc.
  }

  /**
   * Handle incoming messages
   */
  async handleMessage(igsid, message) {
    console.log('[InstagramDMBot] Handling message from:', igsid);

    try {
      // Check if user is linked
      const connection = await this.getConnection(igsid);

      if (!connection) {
        console.log('[InstagramDMBot] User not linked, sending link message');
        await this.sendLinkAccountMessage(igsid);
        return;
      }

      console.log('[InstagramDMBot] User linked to account:', connection.user_id);

      // Get user's name for personalized messages
      const userName = await this.getUserName(connection.user_id);

      // Update last message timestamp
      await this.updateLastMessage(igsid);

      // Extract URL from message
      const url = this.extractUrl(message);

      if (!url) {
        await this.sendMessage(igsid, "Found a recipe on Instagram you want to save? Just share the post with me!");
        return;
      }

      console.log('[InstagramDMBot] Extracted URL:', url);

      // Check if it's an Instagram URL
      if (!this.isInstagramUrl(url)) {
        await this.sendMessage(igsid, "That doesn't look like an Instagram link. Please share a recipe post from Instagram.");
        return;
      }

      // Send processing message (randomly selected for personality)
      const extractingMsgFn = EXTRACTING_MESSAGES[Math.floor(Math.random() * EXTRACTING_MESSAGES.length)];
      await this.sendMessage(igsid, extractingMsgFn(userName));

      // Extract and save recipe
      const result = await this.extractAndSaveRecipe(url, connection.user_id);

      if (result.success) {
        await this.sendRecipeConfirmation(igsid, result.recipe, userName);
      } else {
        await this.sendErrorMessage(igsid, result.error);
      }

    } catch (error) {
      console.error('[InstagramDMBot] Error handling message:', error);
      await this.sendMessage(igsid, "Something went wrong. Please try again later.");
    }
  }

  /**
   * Extract URL from message (attachments or text)
   */
  extractUrl(message) {
    // Check attachments first (shared posts come as attachments)
    if (message.attachments) {
      for (const attachment of message.attachments) {
        // Shared posts may have type 'share' or 'fallback' with URL
        if ((attachment.type === 'share' || attachment.type === 'fallback') && attachment.url) {
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
      console.log('[InstagramDMBot] Starting recipe extraction for user:', userId);

      // Extract with Apify
      const apifyData = await this.apifyService.extractFromUrl(url, userId);

      if (!apifyData.success) {
        console.log('[InstagramDMBot] Apify extraction failed:', apifyData.error);
        return {
          success: false,
          error: apifyData.limitExceeded
            ? 'You\'ve reached your monthly import limit. Upgrade to Premium for more!'
            : apifyData.error || 'Could not extract content from this post'
        };
      }

      console.log('[InstagramDMBot] Apify extraction successful');

      // Use multi-modal extractor
      const result = await this.multiModalExtractor.extractWithAllModalities(apifyData);

      if (!result.success || !result.recipe) {
        console.log('[InstagramDMBot] Multi-modal extraction failed');
        return {
          success: false,
          error: 'Could not find a recipe in this post. Make sure it contains ingredients and instructions.'
        };
      }

      console.log('[InstagramDMBot] Multi-modal extraction successful');

      // Download and store image
      const tempRecipeId = `instagram-dm-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
      let permanentImageUrl = null;
      const primaryImageUrl = result.recipe.image || apifyData.images?.[0]?.url;

      if (primaryImageUrl && primaryImageUrl.startsWith('http')) {
        permanentImageUrl = await this.apifyService.downloadInstagramImage(
          primaryImageUrl,
          tempRecipeId,
          userId,
          apifyData
        );
      }

      const PLACEHOLDER_IMAGE = 'https://images.unsplash.com/photo-1546069901-ba9599a7e63c?w=400';
      const finalImageUrl = permanentImageUrl || PLACEHOLDER_IMAGE;

      // Sanitize recipe data
      const sanitizedRecipe = sanitizeRecipeData({
        ...result.recipe,
        source_type: 'instagram',
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
        console.error('[InstagramDMBot] Nutrition processing failed:', nutritionError.message);
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

      console.log('[InstagramDMBot] Recipe saved with ID:', savedRecipe.id);

      return {
        success: true,
        recipe: savedRecipe
      };

    } catch (error) {
      console.error('[InstagramDMBot] Extract and save error:', error);
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
        source_type: recipeData.source_type || 'instagram',
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
        console.error('[InstagramDMBot] Save recipe error:', error);
        return null;
      }

      // Increment usage counter
      await this.incrementUsageCounter(userId);

      return data;

    } catch (error) {
      console.error('[InstagramDMBot] Save recipe error:', error);
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
      console.error('[InstagramDMBot] Failed to increment usage counter:', error);
      // Don't fail the save if counter increment fails
    }
  }

  /**
   * Get Instagram DM connection for an IGSID
   */
  async getConnection(igsid) {
    const { data, error } = await this.supabase
      .from('instagram_dm_connections')
      .select('*')
      .eq('instagram_user_id', igsid)
      .single();

    if (error && error.code !== 'PGRST116') {
      console.error('[InstagramDMBot] Get connection error:', error);
    }

    return data;
  }

  /**
   * Update last message timestamp
   */
  async updateLastMessage(igsid) {
    await this.supabase
      .from('instagram_dm_connections')
      .update({ last_message_at: new Date().toISOString() })
      .eq('instagram_user_id', igsid);
  }

  /**
   * Generate a link token for account linking
   */
  generateLinkToken(igsid) {
    const token = crypto.randomBytes(32).toString('hex');
    return token;
  }

  /**
   * Store link token in database
   */
  async storeLinkToken(igsid, token) {
    const expiresAt = new Date(Date.now() + this.linkTokenExpiry).toISOString();

    await this.supabase
      .from('instagram_dm_link_tokens')
      .insert({
        instagram_user_id: igsid,
        token: token,
        expires_at: expiresAt
      });

    return token;
  }

  /**
   * Validate a link token
   */
  async validateLinkToken(igsid, token) {
    const { data, error } = await this.supabase
      .from('instagram_dm_link_tokens')
      .select('*')
      .eq('instagram_user_id', igsid)
      .eq('token', token)
      .eq('used', false)
      .gt('expires_at', new Date().toISOString())
      .single();

    return !!data;
  }

  /**
   * Mark link token as used and create connection
   */
  async completeLinking(igsid, token, userId) {
    // Mark token as used
    await this.supabase
      .from('instagram_dm_link_tokens')
      .update({ used: true })
      .eq('instagram_user_id', igsid)
      .eq('token', token);

    // Create connection
    const { data, error } = await this.supabase
      .from('instagram_dm_connections')
      .upsert({
        user_id: userId,
        instagram_user_id: igsid,
        linked_at: new Date().toISOString()
      }, {
        onConflict: 'instagram_user_id'
      })
      .select()
      .single();

    if (error) {
      console.error('[InstagramDMBot] Complete linking error:', error);
      return false;
    }

    // Get user's name for personalized message
    const userName = await this.getUserName(userId);

    // Send confirmation message to Instagram DM
    const confirmationMsg = userName
      ? `You're connected, ${userName}! From now on, just share any Instagram recipe post to me and I'll save it to your Trackabite account.`
      : "You're connected! From now on, just share any Instagram recipe post to me and I'll save it to your Trackabite account.";
    await this.sendMessage(igsid, confirmationMsg);

    return true;
  }

  /**
   * Send a simple text message via Instagram Messaging API
   */
  async sendMessage(igsid, text) {
    if (!this.pageAccessToken) {
      console.error('[InstagramDMBot] Page access token not configured');
      return false;
    }

    try {
      const response = await fetch(
        `https://graph.facebook.com/${this.graphApiVersion}/me/messages?access_token=${this.pageAccessToken}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            recipient: { id: igsid },
            message: { text }
          })
        }
      );

      const data = await response.json();

      if (data.error) {
        console.error('[InstagramDMBot] Send message error:', data.error);
        return false;
      }

      return true;

    } catch (error) {
      console.error('[InstagramDMBot] Send message error:', error);
      return false;
    }
  }

  /**
   * Send account linking message with button
   */
  async sendLinkAccountMessage(igsid) {
    if (!this.pageAccessToken) {
      console.error('[InstagramDMBot] Page access token not configured');
      return false;
    }

    // Generate and store link token
    const token = this.generateLinkToken(igsid);
    await this.storeLinkToken(igsid, token);

    const frontendUrl = process.env.FRONTEND_URL || 'https://trackabite.com';
    const linkUrl = `${frontendUrl}/link-instagram-dm?igsid=${igsid}&token=${token}`;

    try {
      // Instagram Messaging API supports generic templates similar to Messenger
      const response = await fetch(
        `https://graph.facebook.com/${this.graphApiVersion}/me/messages?access_token=${this.pageAccessToken}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            recipient: { id: igsid },
            message: {
              attachment: {
                type: 'template',
                payload: {
                  template_type: 'generic',
                  elements: [{
                    title: 'Welcome to Trackabite!',
                    subtitle: 'I can save Instagram recipes directly to your account. Just share any recipe post with me! First, let\'s link your account.',
                    buttons: [{
                      type: 'web_url',
                      url: linkUrl,
                      title: 'Link My Account'
                    }]
                  }]
                }
              }
            }
          })
        }
      );

      const data = await response.json();

      if (data.error) {
        console.error('[InstagramDMBot] Send link message error:', data.error);
        // Fall back to simple text message with link
        await this.sendMessage(igsid, `Welcome to Trackabite! I can save Instagram recipes directly to your account.\n\nTo get started, link your account here:\n${linkUrl}`);
        return true;
      }

      return true;

    } catch (error) {
      console.error('[InstagramDMBot] Send link message error:', error);
      // Fall back to simple text message
      await this.sendMessage(igsid, `Welcome to Trackabite! Link your account to save recipes:\n${linkUrl}`);
      return false;
    }
  }

  /**
   * Send recipe confirmation with button to open in app
   */
  async sendRecipeConfirmation(igsid, recipe, userName = null) {
    if (!this.pageAccessToken) {
      console.error('[InstagramDMBot] Page access token not configured');
      return false;
    }

    const frontendUrl = process.env.FRONTEND_URL || 'https://trackabite.com';
    const recipeUrl = `${frontendUrl}/open-recipe/${recipe.id}`;

    const savedText = userName ? `Recipe saved, ${userName}!` : 'Recipe saved!';

    try {
      const response = await fetch(
        `https://graph.facebook.com/${this.graphApiVersion}/me/messages?access_token=${this.pageAccessToken}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            recipient: { id: igsid },
            message: {
              attachment: {
                type: 'template',
                payload: {
                  template_type: 'generic',
                  elements: [{
                    title: savedText,
                    subtitle: `${recipe.title}${recipe.source_author ? ` by ${recipe.source_author}` : ''}${recipe.readyInMinutes ? ` | ${recipe.readyInMinutes} min` : ''}`,
                    buttons: [{
                      type: 'web_url',
                      url: recipeUrl,
                      title: 'View Recipe'
                    }]
                  }]
                }
              }
            }
          })
        }
      );

      const data = await response.json();

      if (data.error) {
        console.error('[InstagramDMBot] Send confirmation error:', data.error);
        // Fall back to simple text message
        const fallbackText = userName
          ? `Recipe saved, ${userName}! "${recipe.title}" has been added to your Trackabite account.\n\nView it here: ${recipeUrl}`
          : `Recipe saved! "${recipe.title}" has been added to your Trackabite account.\n\nView it here: ${recipeUrl}`;
        await this.sendMessage(igsid, fallbackText);
      }

      return true;

    } catch (error) {
      console.error('[InstagramDMBot] Send confirmation error:', error);
      // Fall back to simple text message
      const fallbackText = userName
        ? `Recipe saved, ${userName}! "${recipe.title}" has been added to your Trackabite account.`
        : `Recipe saved! "${recipe.title}" has been added to your Trackabite account.`;
      await this.sendMessage(igsid, fallbackText);
      return false;
    }
  }

  /**
   * Send error message
   */
  async sendErrorMessage(igsid, error) {
    const message = `I couldn't extract a recipe from that post.\n\nThis might be because:\n- The post doesn't contain a recipe\n- It's a private post I can't access\n- The post format isn't supported\n\nTry sharing a different recipe post!`;

    await this.sendMessage(igsid, message);
  }

  /**
   * Get connection status for a user (for settings page)
   */
  async getConnectionForUser(userId) {
    const { data, error } = await this.supabase
      .from('instagram_dm_connections')
      .select('*')
      .eq('user_id', userId)
      .single();

    if (error && error.code !== 'PGRST116') {
      console.error('[InstagramDMBot] Get user connection error:', error);
    }

    return data;
  }

  /**
   * Disconnect Instagram DM for a user
   */
  async disconnectUser(userId) {
    const { error } = await this.supabase
      .from('instagram_dm_connections')
      .delete()
      .eq('user_id', userId);

    if (error) {
      console.error('[InstagramDMBot] Disconnect error:', error);
      return false;
    }

    return true;
  }
}

module.exports = new InstagramDMBot();
