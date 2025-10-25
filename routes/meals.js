const express = require('express');
const router = express.Router();
const multer = require('multer');
const mealController = require('../controller/mealController');
const authMiddleware = require('../middleware/auth');
// Meal logs are now unlimited for all tiers - no limit check needed

// Configure multer for image uploads
const storage = multer.memoryStorage();
const upload = multer({
  storage: storage,
  limits: {
    fileSize: 10 * 1024 * 1024 // 10MB limit
  },
  fileFilter: (req, file, cb) => {
    // Accept only image files
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Only image files are allowed'), false);
    }
  }
});

// Routes - Meal logs are unlimited, only authentication required
router.post('/scan', authMiddleware.authenticateToken, upload.single('image'), mealController.scanMeal);
router.post('/log', authMiddleware.authenticateToken, mealController.logMeal);
router.post('/dine-out', authMiddleware.authenticateToken, upload.single('image'), mealController.logDineOutMeal);
router.get('/history', authMiddleware.authenticateToken, mealController.getMealHistory);
router.put('/:id', authMiddleware.authenticateToken, mealController.updateMeal);
router.delete('/:id', authMiddleware.authenticateToken, mealController.deleteMeal);

module.exports = router;