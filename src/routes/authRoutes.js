const express = require('express');
const authController = require('../controllers/authController');
const { requireAuth } = require('../middleware/authMiddleware');
const { limitAuthRequests } = require('../middleware/authRateLimiter');

const router = express.Router();

router.post('/signup', limitAuthRequests, authController.signup);
router.post('/login', limitAuthRequests, authController.login);
router.get('/me', requireAuth, authController.me);

module.exports = router;
