const express = require('express');
const inventoryController = require('../controller/inventoryController');
const { authenticateToken } = require('../middleware/auth');
const { checkInventoryLimit } = require('../middleware/checkLimits');

const router = express.Router();

// All inventory routes require authentication
router.use(authenticateToken);

// Create new inventory items for authenticated user
// Check limit BEFORE creating
router.post('/', checkInventoryLimit, inventoryController.createItems);

// Get all inventory items for authenticated user
router.get('/', inventoryController.getInventory);

// Validate serving size against inventory capacity
router.get('/validate-servings', inventoryController.validateServingSize);

// Update specific inventory item
router.put('/:id', inventoryController.updateItem);

// Delete specific inventory item
router.delete('/:id', inventoryController.deleteItem);

module.exports = router;