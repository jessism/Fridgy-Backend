const express = require('express');
const { authenticateToken } = require('../middleware/auth');
const cookEventsController = require('../controller/cookEventsController');

const router = express.Router();

// POST /api/cook-events — record a Cooking Mode completion (mobile ✓ button).
// Fire-and-forget from the client; any tier. Not premium-gated: the data has
// to accumulate for everyone so the Insights cooking section has history.
router.post('/', authenticateToken, cookEventsController.createCookEvent);

module.exports = router;
