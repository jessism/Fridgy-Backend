const express = require('express');
const router = express.Router();
const { ingredientImagesController, upload } = require('../controller/ingredientImagesController');
const { authenticateToken: authMiddleware } = require('../middleware/auth');

// Public routes (no authentication required)
// Get image by ingredient name
router.get('/match/:name', ingredientImagesController.getImageByName);

// Get all images with pagination
router.get('/', ingredientImagesController.getAllImages);

// Batch match multiple ingredients
router.post('/batch-match', ingredientImagesController.batchMatch);

// Protected routes (authentication required)
// Upload new ingredient image
router.post('/upload', authMiddleware, upload.single('image'), ingredientImagesController.uploadImage);

// Update ingredient image metadata
router.put('/:id', authMiddleware, ingredientImagesController.updateImage);

// Delete ingredient image
router.delete('/:id', authMiddleware, ingredientImagesController.deleteImage);

module.exports = router;