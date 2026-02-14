const { Expo } = require('expo-server-sdk');

class ExpoPushService {
  constructor() {
    this.expo = new Expo({
      accessToken: process.env.EXPO_ACCESS_TOKEN,
      useFcmV1: true,
    });
  }

  isValidToken(token) {
    return Expo.isExpoPushToken(token);
  }

  /**
   * Send push notifications to multiple Expo tokens.
   * Handles chunking internally per expo-server-sdk docs.
   * @param {string[]} tokens
   * @param {Object} payload - { title, body, data, sound, badge, channelId, priority }
   * @returns {Promise<Array<{ token, success, error?, ticketId? }>>}
   */
  async sendNotifications(tokens, payload) {
    const messages = tokens
      .filter(token => this.isValidToken(token))
      .map(token => ({
        to: token,
        title: payload.title,
        body: payload.body,
        data: payload.data || {},
        sound: payload.sound || 'default',
        badge: payload.badge !== undefined ? payload.badge : 1,
        channelId: payload.channelId || 'default',
        priority: payload.priority || 'high',
      }));

    if (messages.length === 0) {
      console.log('[ExpoPush] No valid tokens to send to');
      return [];
    }

    const chunks = this.expo.chunkPushNotifications(messages);
    const results = [];

    for (const chunk of chunks) {
      try {
        const ticketChunk = await this.expo.sendPushNotificationsAsync(chunk);
        for (let i = 0; i < ticketChunk.length; i++) {
          const ticket = ticketChunk[i];
          results.push({
            token: chunk[i].to,
            success: ticket.status === 'ok',
            error: ticket.status === 'error'
              ? (ticket.details?.error || ticket.message)
              : null,
            ticketId: ticket.id || null,
          });
        }
      } catch (error) {
        console.error('[ExpoPush] Error sending chunk:', error.message);
        chunk.forEach(msg => results.push({
          token: msg.to,
          success: false,
          error: error.message,
          ticketId: null,
        }));
      }
    }

    return results;
  }

  /**
   * Check delivery receipts (call 15+ minutes after sending).
   * @param {string[]} ticketIds
   * @returns {Promise<Object>} Map of ticketId -> receipt
   */
  async checkReceipts(ticketIds) {
    const chunks = this.expo.chunkPushNotificationReceiptIds(ticketIds);
    const allReceipts = {};

    for (const chunk of chunks) {
      try {
        const receipts = await this.expo.getPushNotificationReceiptsAsync(chunk);
        Object.assign(allReceipts, receipts);
      } catch (error) {
        console.error('[ExpoPush] Error checking receipts:', error.message);
      }
    }

    return allReceipts;
  }
}

module.exports = new ExpoPushService();
