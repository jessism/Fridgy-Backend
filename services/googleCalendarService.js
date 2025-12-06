/**
 * Google Calendar Service
 * Handles OAuth and Calendar API interactions for meal plan sync
 */

const { google } = require('googleapis');

class GoogleCalendarService {
  constructor() {
    this.oauth2Client = null;
    this.initializeClient();
  }

  initializeClient() {
    const clientId = process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
    const redirectUri = process.env.GOOGLE_REDIRECT_URI || 'http://localhost:5000/api/calendar/callback';

    if (clientId && clientSecret) {
      this.oauth2Client = new google.auth.OAuth2(clientId, clientSecret, redirectUri);
    } else {
      console.warn('[GoogleCalendar] Missing GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET');
    }
  }

  /**
   * Check if the service is properly configured
   */
  isConfigured() {
    return this.oauth2Client !== null;
  }

  /**
   * Generate OAuth URL for user authorization
   * @param {string} state - State parameter (usually contains userId)
   * @returns {string} Authorization URL
   */
  getAuthUrl(state) {
    if (!this.oauth2Client) {
      throw new Error('Google Calendar service not configured');
    }

    const scopes = [
      'https://www.googleapis.com/auth/calendar.events',
      'https://www.googleapis.com/auth/userinfo.email'
    ];

    return this.oauth2Client.generateAuthUrl({
      access_type: 'offline',
      scope: scopes,
      state: state,
      prompt: 'consent' // Force refresh token generation
    });
  }

  /**
   * Exchange authorization code for tokens
   * @param {string} code - Authorization code from OAuth callback
   * @returns {Object} Token object with access_token, refresh_token, expiry_date
   */
  async exchangeCodeForTokens(code) {
    if (!this.oauth2Client) {
      throw new Error('Google Calendar service not configured');
    }

    const { tokens } = await this.oauth2Client.getToken(code);
    return tokens;
  }

  /**
   * Refresh an expired access token
   * @param {string} refreshToken - Refresh token
   * @returns {Object} New token credentials
   */
  async refreshAccessToken(refreshToken) {
    if (!this.oauth2Client) {
      throw new Error('Google Calendar service not configured');
    }

    this.oauth2Client.setCredentials({ refresh_token: refreshToken });
    const { credentials } = await this.oauth2Client.refreshAccessToken();
    return credentials;
  }

  /**
   * Get user's email from Google
   * @param {string} accessToken - Valid access token
   * @returns {string} User's email address
   */
  async getUserEmail(accessToken) {
    if (!this.oauth2Client) {
      throw new Error('Google Calendar service not configured');
    }

    this.oauth2Client.setCredentials({ access_token: accessToken });
    const oauth2 = google.oauth2({ version: 'v2', auth: this.oauth2Client });
    const { data } = await oauth2.userinfo.get();
    return data.email;
  }

  /**
   * Create a calendar event for a meal
   * @param {Object} tokens - { access_token, refresh_token }
   * @param {Object} mealPlan - Meal plan data
   * @param {Object} preferences - User's meal time preferences
   * @returns {string} Created event ID
   */
  async createMealEvent(tokens, mealPlan, preferences) {
    if (!this.oauth2Client) {
      throw new Error('Google Calendar service not configured');
    }

    this.oauth2Client.setCredentials(tokens);
    const calendar = google.calendar({ version: 'v3', auth: this.oauth2Client });

    const event = this.buildCalendarEvent(mealPlan, preferences);

    const response = await calendar.events.insert({
      calendarId: 'primary',
      resource: event
    });

    return response.data.id;
  }

  /**
   * Update an existing calendar event
   * @param {Object} tokens - { access_token, refresh_token }
   * @param {string} eventId - Calendar event ID
   * @param {Object} mealPlan - Updated meal plan data
   * @param {Object} preferences - User's meal time preferences
   */
  async updateMealEvent(tokens, eventId, mealPlan, preferences) {
    if (!this.oauth2Client) {
      throw new Error('Google Calendar service not configured');
    }

    this.oauth2Client.setCredentials(tokens);
    const calendar = google.calendar({ version: 'v3', auth: this.oauth2Client });

    const event = this.buildCalendarEvent(mealPlan, preferences);

    await calendar.events.update({
      calendarId: 'primary',
      eventId: eventId,
      resource: event
    });
  }

  /**
   * Delete a calendar event
   * @param {Object} tokens - { access_token, refresh_token }
   * @param {string} eventId - Calendar event ID to delete
   */
  async deleteMealEvent(tokens, eventId) {
    if (!this.oauth2Client) {
      throw new Error('Google Calendar service not configured');
    }

    this.oauth2Client.setCredentials(tokens);
    const calendar = google.calendar({ version: 'v3', auth: this.oauth2Client });

    try {
      await calendar.events.delete({
        calendarId: 'primary',
        eventId: eventId
      });
    } catch (error) {
      // Ignore 404 errors (event already deleted)
      if (error.code !== 404) {
        throw error;
      }
    }
  }

  /**
   * Build a calendar event object from meal plan data
   * @param {Object} mealPlan - Meal plan data
   * @param {Object} preferences - User's preferences
   * @returns {Object} Google Calendar event object
   */
  buildCalendarEvent(mealPlan, preferences) {
    const timezone = preferences?.timezone || 'America/Los_Angeles';
    const duration = preferences?.meal_duration_minutes || 60;

    // Get the scheduled time or default time for this meal type
    const mealTime = mealPlan.scheduled_time || this.getDefaultTime(mealPlan.meal_type, preferences);

    // Build start datetime string (no Z suffix - Google uses timeZone field)
    const startDateTime = this.buildDateTime(mealPlan.date, mealTime, timezone);

    // Calculate end time by adding duration to start time
    const [hours, minutes] = mealTime.split(':').map(Number);
    const totalMinutes = hours * 60 + minutes + duration;
    const endHours = Math.floor(totalMinutes / 60) % 24;
    const endMins = totalMinutes % 60;
    const endTime = `${String(endHours).padStart(2, '0')}:${String(endMins).padStart(2, '0')}`;
    const endDateTime = `${mealPlan.date}T${endTime}:00`;

    return {
      summary: this.buildEventTitle(mealPlan),
      description: this.buildEventDescription(mealPlan),
      start: {
        dateTime: startDateTime,
        timeZone: timezone
      },
      end: {
        dateTime: endDateTime,
        timeZone: timezone
      },
      colorId: '2' // Green color
    };
  }

  /**
   * Get emoji for meal type
   */
  getMealEmoji(mealType) {
    const emojis = {
      breakfast: '🍳',
      lunch: '🥗',
      dinner: '🍽️',
      snack: '🍎'
    };
    return emojis[mealType] || '🍴';
  }

  /**
   * Build event title from meal plan
   */
  buildEventTitle(mealPlan) {
    const emoji = this.getMealEmoji(mealPlan.meal_type);
    const mealLabel = mealPlan.meal_type.charAt(0).toUpperCase() + mealPlan.meal_type.slice(1);
    const recipeTitle = mealPlan.recipe_snapshot?.title || mealPlan.recipe?.title || 'Planned Meal';
    return `${emoji} ${mealLabel}: ${recipeTitle}`;
  }

  /**
   * Build event description from meal plan
   */
  buildEventDescription(mealPlan) {
    const lines = ['Recipe from Trackabite', ''];

    const readyInMinutes = mealPlan.recipe_snapshot?.readyInMinutes || mealPlan.recipe?.readyInMinutes;
    if (readyInMinutes) {
      lines.push(`Ready in: ${readyInMinutes} minutes`);
    }

    if (mealPlan.recipe_id) {
      lines.push('');
      lines.push(`View recipe: https://trackabite.app/recipes/${mealPlan.recipe_id}`);
    }

    return lines.join('\n');
  }

  /**
   * Get default time for a meal type from preferences
   */
  getDefaultTime(mealType, preferences) {
    const defaults = {
      breakfast: preferences?.breakfast_time || '08:00',
      lunch: preferences?.lunch_time || '12:00',
      dinner: preferences?.dinner_time || '19:00',
      snack: preferences?.snack_time || '15:00'
    };
    return defaults[mealType] || '12:00';
  }

  /**
   * Build an ISO datetime string without timezone suffix
   * Google Calendar will use the timeZone field to interpret this time
   */
  buildDateTime(dateStr, timeStr, timezone) {
    // Parse the time string (HH:MM format), default to noon
    const time = timeStr || '12:00';
    // Return ISO format without timezone suffix
    // e.g., "2025-01-15T08:00:00" - Google uses timeZone field to interpret
    return `${dateStr}T${time}:00`;
  }
}

module.exports = new GoogleCalendarService();
