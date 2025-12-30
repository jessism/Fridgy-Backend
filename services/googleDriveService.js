/**
 * Google Drive Service
 * Handles OAuth and Drive API interactions for recipe PDF sync
 */

const { google } = require('googleapis');

class GoogleDriveService {
  constructor() {
    this.oauth2Client = null;
    this.initializeClient();
  }

  initializeClient() {
    const clientId = process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
    const redirectUri = process.env.GOOGLE_DRIVE_REDIRECT_URI || 'http://localhost:5000/api/drive/callback';

    if (clientId && clientSecret) {
      this.oauth2Client = new google.auth.OAuth2(clientId, clientSecret, redirectUri);
    } else {
      console.warn('[GoogleDrive] Missing GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET');
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
      throw new Error('Google Drive service not configured');
    }

    const scopes = [
      'https://www.googleapis.com/auth/drive.file',  // Only files created by app
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
      throw new Error('Google Drive service not configured');
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
      throw new Error('Google Drive service not configured');
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
      throw new Error('Google Drive service not configured');
    }

    this.oauth2Client.setCredentials({ access_token: accessToken });
    const oauth2 = google.oauth2({ version: 'v2', auth: this.oauth2Client });
    const { data } = await oauth2.userinfo.get();
    return data.email;
  }

  /**
   * Create or find the Trackabite Recipes folder in user's Drive
   * @param {Object} tokens - { access_token, refresh_token }
   * @param {string} folderName - Name of the folder to create
   * @returns {string} Folder ID
   */
  async createFolder(tokens, folderName = 'Trackabite Recipes') {
    if (!this.oauth2Client) {
      throw new Error('Google Drive service not configured');
    }

    this.oauth2Client.setCredentials(tokens);
    const drive = google.drive({ version: 'v3', auth: this.oauth2Client });

    // Check if folder already exists
    const existing = await drive.files.list({
      q: `name='${folderName}' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
      fields: 'files(id, name)',
      spaces: 'drive'
    });

    if (existing.data.files && existing.data.files.length > 0) {
      console.log(`[GoogleDrive] Found existing folder: ${existing.data.files[0].id}`);
      return existing.data.files[0].id;
    }

    // Create new folder
    const response = await drive.files.create({
      requestBody: {
        name: folderName,
        mimeType: 'application/vnd.google-apps.folder'
      },
      fields: 'id'
    });

    console.log(`[GoogleDrive] Created new folder: ${response.data.id}`);
    return response.data.id;
  }

  /**
   * Upload a PDF file to Google Drive
   * @param {Object} tokens - { access_token, refresh_token }
   * @param {string} folderId - Folder ID to upload to
   * @param {string} fileName - Name of the file
   * @param {Buffer} pdfBuffer - PDF content as buffer
   * @param {string|null} existingFileId - If provided, update existing file
   * @returns {string} File ID
   */
  async uploadFile(tokens, folderId, fileName, pdfBuffer, existingFileId = null) {
    if (!this.oauth2Client) {
      throw new Error('Google Drive service not configured');
    }

    this.oauth2Client.setCredentials(tokens);
    const drive = google.drive({ version: 'v3', auth: this.oauth2Client });

    const { Readable } = require('stream');
    const media = {
      mimeType: 'application/pdf',
      body: Readable.from([pdfBuffer])  // Wrap in array to stream entire buffer as one chunk
    };

    if (existingFileId) {
      // Update existing file
      console.log(`[GoogleDrive] Updating existing file: ${existingFileId}`);
      const response = await drive.files.update({
        fileId: existingFileId,
        media: media,
        fields: 'id'
      });
      return response.data.id;
    } else {
      // Create new file
      console.log(`[GoogleDrive] Creating new file: ${fileName}`);
      const response = await drive.files.create({
        requestBody: {
          name: fileName,
          parents: [folderId]
        },
        media: media,
        fields: 'id'
      });
      return response.data.id;
    }
  }

  /**
   * Delete a file from Google Drive
   * @param {Object} tokens - { access_token, refresh_token }
   * @param {string} fileId - File ID to delete
   */
  async deleteFile(tokens, fileId) {
    if (!this.oauth2Client) {
      throw new Error('Google Drive service not configured');
    }

    this.oauth2Client.setCredentials(tokens);
    const drive = google.drive({ version: 'v3', auth: this.oauth2Client });

    try {
      await drive.files.delete({
        fileId: fileId
      });
      console.log(`[GoogleDrive] Deleted file: ${fileId}`);
    } catch (error) {
      // Ignore 404 errors (file already deleted)
      if (error.code !== 404) {
        throw error;
      }
    }
  }

  /**
   * Get file metadata
   * @param {Object} tokens - { access_token, refresh_token }
   * @param {string} fileId - File ID
   * @returns {Object} File metadata
   */
  async getFileMetadata(tokens, fileId) {
    if (!this.oauth2Client) {
      throw new Error('Google Drive service not configured');
    }

    this.oauth2Client.setCredentials(tokens);
    const drive = google.drive({ version: 'v3', auth: this.oauth2Client });

    const response = await drive.files.get({
      fileId: fileId,
      fields: 'id, name, webViewLink, createdTime, modifiedTime'
    });

    return response.data;
  }
}

module.exports = new GoogleDriveService();
