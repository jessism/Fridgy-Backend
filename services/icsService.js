/**
 * ICS Calendar Service
 * Generates iCalendar (ICS) format for Apple Calendar, Outlook, and other calendar apps
 */

const crypto = require('crypto');

class ICSService {
  /**
   * Generate a unique subscription token for a user
   * @returns {string} 64-character random token
   */
  generateSubscriptionToken() {
    return crypto.randomBytes(32).toString('hex');
  }

  /**
   * Generate ICS calendar content from meal plans
   * @param {Array} mealPlans - User's meal plans with recipe data
   * @param {Object} preferences - User's meal time preferences
   * @returns {string} Valid ICS file content
   */
  generateICS(mealPlans, preferences) {
    const events = mealPlans
      .filter(plan => plan.recipe_id || plan.recipe_snapshot)
      .map(plan => this.mealToVEvent(plan, preferences));

    const lines = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//Trackabite//Meal Plans//EN',
      'X-WR-CALNAME:Trackabite Meals',
      'X-WR-CALDESC:Your meal plans from Trackabite',
      'METHOD:PUBLISH',
      'CALSCALE:GREGORIAN',
      ...events.flat(),
      'END:VCALENDAR'
    ];

    return lines.join('\r\n');
  }

  /**
   * Convert a meal plan to VEVENT format
   * @param {Object} mealPlan - Meal plan data
   * @param {Object} preferences - User's preferences
   * @returns {Array<string>} ICS VEVENT lines
   */
  mealToVEvent(mealPlan, preferences) {
    const uid = `meal-${mealPlan.id}@trackabite.app`;
    const startTime = this.getStartDateTime(mealPlan, preferences);
    const endTime = this.getEndDateTime(startTime, preferences?.meal_duration_minutes || 30);
    const emoji = this.getMealEmoji(mealPlan.meal_type);
    const title = mealPlan.recipe_snapshot?.title || mealPlan.recipe?.title || 'Planned Meal';
    const mealLabel = this.capitalize(mealPlan.meal_type);

    return [
      'BEGIN:VEVENT',
      `UID:${uid}`,
      `DTSTAMP:${this.formatDateTime(new Date())}`,
      `DTSTART:${this.formatDateTime(startTime)}`,
      `DTEND:${this.formatDateTime(endTime)}`,
      `SUMMARY:${emoji} ${mealLabel}: ${this.escapeICSText(title)}`,
      `DESCRIPTION:${this.buildDescription(mealPlan)}`,
      'STATUS:CONFIRMED',
      'TRANSP:TRANSPARENT',
      'END:VEVENT'
    ];
  }

  /**
   * Get start datetime for a meal plan
   */
  getStartDateTime(mealPlan, preferences) {
    const mealTime = mealPlan.scheduled_time || this.getDefaultTime(mealPlan.meal_type, preferences);
    return this.buildDateTime(mealPlan.date, mealTime);
  }

  /**
   * Get end datetime given start and duration
   */
  getEndDateTime(startTime, durationMinutes) {
    const endTime = new Date(startTime);
    endTime.setMinutes(endTime.getMinutes() + durationMinutes);
    return endTime;
  }

  /**
   * Get default time for a meal type
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
   * Build a Date object from date string and time string
   */
  buildDateTime(dateStr, timeStr) {
    const [hours, minutes] = (timeStr || '12:00').split(':').map(Number);
    const date = new Date(dateStr);
    date.setHours(hours, minutes, 0, 0);
    return date;
  }

  /**
   * Format date to ICS datetime format
   * @param {Date} date - Date object
   * @returns {string} ICS format: YYYYMMDDTHHMMSSZ
   */
  formatDateTime(date) {
    const year = date.getUTCFullYear();
    const month = String(date.getUTCMonth() + 1).padStart(2, '0');
    const day = String(date.getUTCDate()).padStart(2, '0');
    const hours = String(date.getUTCHours()).padStart(2, '0');
    const mins = String(date.getUTCMinutes()).padStart(2, '0');
    const secs = String(date.getUTCSeconds()).padStart(2, '0');

    return `${year}${month}${day}T${hours}${mins}${secs}Z`;
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
   * Build event description
   */
  buildDescription(mealPlan) {
    const lines = ['Recipe from Trackabite'];

    const readyInMinutes = mealPlan.recipe_snapshot?.readyInMinutes || mealPlan.recipe?.readyInMinutes;
    if (readyInMinutes) {
      lines.push(`Ready in: ${readyInMinutes} minutes`);
    }

    if (mealPlan.recipe_id) {
      lines.push(`View: https://trackabite.app/recipes/${mealPlan.recipe_id}`);
    }

    // ICS uses \n for newlines in description (escaped)
    return lines.join('\\n');
  }

  /**
   * Escape text for ICS format
   * @param {string} text - Text to escape
   * @returns {string} Escaped text
   */
  escapeICSText(text) {
    if (!text) return '';
    return text
      .replace(/\\/g, '\\\\')
      .replace(/;/g, '\\;')
      .replace(/,/g, '\\,')
      .replace(/\n/g, '\\n');
  }

  /**
   * Capitalize first letter
   */
  capitalize(str) {
    if (!str) return '';
    return str.charAt(0).toUpperCase() + str.slice(1);
  }

  /**
   * Build webcal URL from https URL
   * @param {string} httpsUrl - HTTPS URL
   * @returns {string} webcal:// URL
   */
  httpsToWebcal(httpsUrl) {
    // webcal:// is the standard protocol recognized by Safari/iOS
    // The calendar app will automatically use HTTPS when fetching from HTTPS domains
    return httpsUrl.replace(/^https?:\/\//, 'webcal://');
  }
}

module.exports = new ICSService();
