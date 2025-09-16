const express = require('express');
const router = express.Router();
const onboardingController = require('../controller/onboardingController');
const authMiddleware = require('../middleware/auth');

// Public routes (no auth required during onboarding)
router.post('/save-progress', onboardingController.saveProgress);
router.get('/progress', onboardingController.getProgress);

// Protected routes (require auth after account creation)
router.post('/complete', authMiddleware.authenticateToken, onboardingController.completeOnboarding);
router.get('/user-onboarding', authMiddleware.authenticateToken, onboardingController.getUserOnboardingData);
router.post('/skip', onboardingController.skipOnboarding);

module.exports = router;