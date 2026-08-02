const rateLimit = require('express-rate-limit');

// Rate limiter for shortcut import endpoint
const shortcutImportLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute window
  max: 10, // limit each token to 10 requests per minute
  message: 'Too many requests, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    // Use token as the key for rate limiting, fallback to IP
    return req.body?.token || req.socket.remoteAddress;
  },
  skip: (req) => {
    // Skip rate limiting in development
    return process.env.NODE_ENV === 'development';
  },
  handler: (req, res) => {
    res.status(429).json({
      success: false,
      error: 'Too many requests. Please wait a moment before trying again.'
    });
  }
});

// General API rate limiter
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per 15 minutes
  message: 'Too many requests from this IP, please try again later.',
  standardHeaders: true,
  legacyHeaders: false
});

// Premium voice TTS: sentence pipelining is chatty (a long step bursts ~6
// requests), so per-user limits are generous but bound abuse
const voiceTtsSpeakLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 40,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.user?.id || req.socket.remoteAddress,
  handler: (req, res) => {
    res.status(429).json({
      success: false,
      error: 'Too many voice requests. Please wait a moment.',
      code: 'BUSY'
    });
  }
});

const voiceTtsPrewarmLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 3,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.user?.id || req.socket.remoteAddress,
  handler: (req, res) => {
    // Prewarm is best-effort - a rate-limited prewarm is not an error the app cares about
    res.status(200).json({ success: true, warmed: false, reason: 'rate-limited' });
  }
});

module.exports = {
  shortcutImportLimiter,
  apiLimiter,
  voiceTtsSpeakLimiter,
  voiceTtsPrewarmLimiter
};