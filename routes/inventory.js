const express = require('express');
const inventoryController = require('../controller/inventoryController');

const router = express.Router();

// Get all inventory items for authenticated user
router.get('/', inventoryController.getInventory);

// Update specific inventory item
router.put('/:id', inventoryController.updateItem);

// Delete specific inventory item
router.delete('/:id', inventoryController.deleteItem);

module.exports = router;