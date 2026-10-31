/**
 * resumeRoutes.js
 * -----------------------------------------------------------------------
 * Module 4 — Resume Processing & Resume Intelligence
 * Owner: Siddhant Raikar
 *
 * Route table matches the LLD slide exactly:
 *   POST /api/resume/upload
 *   GET  /api/resume/:id
 *   GET  /api/resume/:id/context    (extra — needed by the Interview module)
 *   GET  /api/resume/:id/questions  (demo-only — see questionGeneratorService.js)
 * -----------------------------------------------------------------------
 */

const express = require('express');
const multer = require('multer');
const resumeController = require('../controllers/resumeController');
const { MAX_FILE_SIZE_BYTES } = require('../services/pdfService');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE_BYTES },
});

const router = express.Router();

router.post('/upload', upload.single('resume'), resumeController.uploadResume);
router.get('/:id', resumeController.getResume);
router.get('/:id/context', resumeController.getContext);
router.get('/:id/questions', resumeController.getQuestions);
router.post('/:id/questions/:category', resumeController.generateCategoryQuestions);

module.exports = router;
