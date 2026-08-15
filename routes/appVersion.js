const express = require('express');
const router = express.Router();

// Public, unauthenticated — the mobile version gate must work logged out.
// Values live in Railway env vars so the floor can be raised without a deploy.
// Floor default is inert (below every shipped build); raise APP_MIN_SUPPORTED_VERSION
// to 1.1.2 only after Build 31 is live in both stores.
const DEFAULTS = {
  minSupportedVersion: '1.0.0',
  latestVersion: '1.1.1',
  iosStoreUrl: 'https://apps.apple.com/app/id6759185932',
  androidStoreUrl: 'https://play.google.com/store/apps/details?id=com.trackabite.app'
};

// GET /api/app-version
router.get('/', (req, res) => {
  res.set('Cache-Control', 'public, max-age=300');
  res.json({
    minSupportedVersion: process.env.APP_MIN_SUPPORTED_VERSION || DEFAULTS.minSupportedVersion,
    recommendedVersion: process.env.APP_RECOMMENDED_VERSION || null,
    latestVersion: process.env.APP_LATEST_VERSION || DEFAULTS.latestVersion,
    storeUrls: {
      ios: process.env.APP_IOS_STORE_URL || DEFAULTS.iosStoreUrl,
      android: process.env.APP_ANDROID_STORE_URL || DEFAULTS.androidStoreUrl
    }
  });
});

module.exports = router;
