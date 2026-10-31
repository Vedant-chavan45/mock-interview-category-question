const mongoose = require('mongoose');
const Resume = require('../models/Resume');
const pdfService = require('../services/pdfService');
const resumeParserService = require('../services/resumeParserService');
const ollamaService = require('../services/ollamaService');
const contextBuilder = require('../services/contextBuilder');
const questionGeneratorService = require('../services/questionGeneratorService');
const { getQuestionCategory } = require('../services/questionCategories');

const activeCategoryGenerations = new Set();

async function uploadResume(req, res) {
  try {
    if (!mongoose.isObjectIdOrHexString(req.user.id)) {
      return res.status(401).json({ error: 'Invalid user identity. Please log in again.' });
    }
    pdfService.validateFile(req.file);
    const { text, pageCount } = await pdfService.extractText(req.file.buffer);
    const parsedResume = resumeParserService.parse(text);
    const analysis = await ollamaService.analyseResume(parsedResume);
    const { interviewType, targetRole } = req.body;
    const resumeContext = contextBuilder.build(parsedResume, analysis, {
      interviewType,
      targetRole,
    });

    const resume = await Resume.create({
      userId: req.user.id,
      file: {
        originalName: req.file.originalname,
        mimeType: req.file.mimetype,
        sizeBytes: req.file.size,
      },
      parsedResume,
      analysis,
      resumeContext,
      pageCount,
    });

    return res.status(201).json({
      resumeId: resume._id.toString(),
      pageCount,
      parsedResume,
      analysis,
    });
  } catch (err) {
    if (err instanceof pdfService.UnreadableResumeError) {
      return res.status(422).json({ error: err.message });
    }
    console.error('[resumeController.uploadResume] Failed to process or save resume.');
    return res.status(500).json({ error: 'Failed to process resume.' });
  }
}

// All authenticated reads share the same ownership boundary.
// Invalid IDs (including old demo JWT subjects) never reach Mongoose casting.
async function findOwnedResume(req) {
  if (!mongoose.isObjectIdOrHexString(req.params.id) ||
      !mongoose.isObjectIdOrHexString(req.user.id)) {
    return null;
  }
  return Resume.findOne({
    _id: req.params.id,
    userId: req.user.id,
  }).lean();
}

async function getResume(req, res) {
  try {
    const record = await findOwnedResume(req);
    if (!record) return res.status(404).json({ error: 'Resume not found.' });
    return res.json({ parsedResume: record.parsedResume, analysis: record.analysis });
  } catch {
    console.error('[resumeController.getResume] Database read failed.');
    return res.status(500).json({ error: 'Failed to retrieve resume.' });
  }
}

async function getContext(req, res) {
  try {
    const record = await findOwnedResume(req);
    if (!record) return res.status(404).json({ error: 'Resume not found.' });
    return res.json(record.resumeContext);
  } catch {
    console.error('[resumeController.getContext] Database read failed.');
    return res.status(500).json({ error: 'Failed to retrieve resume context.' });
  }
}

// Questions remain on-demand and are not persisted.
async function getQuestions(req, res) {
  try {
    const record = await findOwnedResume(req);
    if (!record) return res.status(404).json({ error: 'Resume not found.' });
    const result = await questionGeneratorService.generateQuestions(record.resumeContext);
    return res.json(result);
  } catch {
    console.error('[resumeController.getQuestions] Failed to read resume or generate questions.');
    return res.status(500).json({ error: 'Failed to generate questions.' });
  }
}

async function generateCategoryQuestions(req, res) {
  const category = getQuestionCategory(req.params.category);
  if (!category) return res.status(400).json({ error: 'Unsupported question category.' });
  const body = req.body;
  if (body !== undefined && (body === null || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length)) {
    return res.status(400).json({ error: 'Category generation does not accept request data.' });
  }
  try {
    const record = await findOwnedResume(req);
    if (!record) return res.status(404).json({ error: 'Resume not found.' });
    const key = `${req.user.id}:${req.params.id}:${category.id}`;
    if (activeCategoryGenerations.has(key)) {
      return res.status(409).json({ error: 'Generation is already in progress for this category.' });
    }
    activeCategoryGenerations.add(key);
    const generation = new AbortController();
    const abortIfDisconnected = () => { if (!res.writableEnded) generation.abort(); };
    res.on?.('close', abortIfDisconnected);
    try {
      const force = req.get?.('X-Regenerate') === 'true' || req.headers?.['x-regenerate'] === 'true';
      const result = await questionGeneratorService.generateCategoryQuestions(record.resumeContext, category.id,
        { force, signal: generation.signal });
      if (result?.status !== 'ready' || result.source !== `ollama-${result.model}` ||
          !Array.isArray(result.questions) || result.questions.length !== 6) {
        return res.status(502).json({ category: category.id, status: 'failed', errorCode: 'invalid-generation',
          error: 'Question generation did not produce a validated AI question set. Retry to try again.' });
      }
      return res.json({ ...result, category: category.id });
    } catch (err) {
      if (generation.signal.aborted) return undefined;
      if (err?.code === 'INSUFFICIENT_RESUME_EVIDENCE') {
        return res.status(422).json({ category: category.id, status: 'insufficient-evidence',
          errorCode: 'insufficient-evidence', error: 'This resume does not contain enough documented evidence for this category.' });
      }
      const validationFailed = err?.message === 'Invalid generated questions.' || err?.diagnosticReason?.includes('question-validation-error');
      const errorCode = validationFailed ? 'invalid-generation' : 'generation-failed';
      // Keep normal logs free of resume contents, but preserve the validator's
      // actionable slot diagnostics (index + slotId). The old log emitted only
      // err.code and hid the exact reason needed to fix category-specific rejects.
      const safeReason = String(err?.diagnosticReason || err?.code || 'unknown').replace(/[\r\n]+/g, ' ').slice(0, 240);
      console.error(`[resumeController.generateCategoryQuestions] category=${category.id} errorCode=${errorCode} ${safeReason}`);
      // Opt-in local debugging only: this is a model-generated question and may
      // contain a project/role name from the user's resume. Never log it by default.
      if (process.env.DEBUG_QUESTION_GENERATION_VERBOSE === '1' && typeof err?.rejectedQuestion === 'string') {
        console.error(`[resumeController.generateCategoryQuestions] rejectedQuestion=${JSON.stringify(err.rejectedQuestion.slice(0, 240))}`);
      }
      return res.status(validationFailed ? 502 : 503).json({ category: category.id, status: 'failed', errorCode,
        error: validationFailed
          ? 'Ollama returned questions that did not pass validation. Retry to generate a new set.'
          : 'Question generation is temporarily unavailable. Check the local Ollama service and retry.' });
    } finally {
      res.off?.('close', abortIfDisconnected);
      activeCategoryGenerations.delete(key);
    }
  } catch {
    console.error('[resumeController.generateCategoryQuestions] Resume lookup failed.');
    return res.status(500).json({ error: 'Failed to read the resume.' });
  }
}

module.exports = { uploadResume, getResume, getContext, getQuestions, generateCategoryQuestions };
