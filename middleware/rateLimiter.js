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

module.exports = {
  shortcutImportLimiter,
  apiLimiter
};