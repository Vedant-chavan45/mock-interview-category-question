const mongoose = require('mongoose');
const Resume = require('../models/Resume');
const pdfService = require('../services/pdfService');
const resumeParserService = require('../services/resumeParserService');
const ollamaService = require('../services/ollamaService');
const contextBuilder = require('../services/contextBuilder');
const questionGeneratorService = require('../services/questionGeneratorService');
const answerEvaluationService = require('../services/answerEvaluationService');
const { getQuestionCategory } = require('../services/questionCategories');

const activeCategoryGenerations = new Set();
const activeAnswerEvaluations = new Set();
const MAX_ANSWER_LENGTH = 8000;

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

// The practice endpoint restores category question sets and evaluations for this owned resume.
async function getPractice(req, res) {
  try {
    const record = await findOwnedResume(req);
    if (!record) return res.status(404).json({ error: 'Resume not found.' });
    const categories = record.practice?.categories && typeof record.practice.categories === 'object'
      ? record.practice.categories : {};
    return res.json({ categories });
  } catch {
    console.error('[resumeController.getPractice] Database read failed.');
    return res.status(500).json({ error: 'Failed to retrieve interview practice data.' });
  }
}

// The older mixed-question demo endpoint is kept for compatibility.
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
    if (activeCategoryGenerations.has(key) || [...activeAnswerEvaluations].some((activeKey) => activeKey.startsWith(`${key}:`))) {
      return res.status(409).json({ error: 'Generation or answer evaluation is already in progress for this category.' });
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
      const savedCategory = {
        categoryId: category.id,
        model: result.model,
        source: result.source,
        status: result.status,
        metrics: result.metrics,
        generatedAt: new Date(),
        questions: result.questions.map((question) => ({ ...question, answer: '', evaluation: null })),
      };
      const update = await Resume.updateOne(
        { _id: req.params.id, userId: req.user.id },
        { $set: { [`practice.categories.${category.id}`]: savedCategory } },
      );
      if (update.matchedCount === 0) return res.status(404).json({ error: 'Resume not found.' });
      return res.json({ ...result, category: category.id, questions: savedCategory.questions });
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


async function evaluateAnswer(req, res) {
  const category = getQuestionCategory(req.params.category);
  if (!category) return res.status(400).json({ error: 'Unsupported question category.' });
  const questionIndex = Number(req.params.questionIndex);
  if (!Number.isInteger(questionIndex) || questionIndex < 0 || questionIndex >= 6) {
    return res.status(400).json({ error: 'Question index must be between 0 and 5.' });
  }
  const body = req.body;
  if (!body || typeof body !== 'object' || Array.isArray(body) ||
      Object.keys(body).some((key) => key !== 'answer') || typeof body.answer !== 'string') {
    return res.status(400).json({ error: 'Submit an answer as a text string.' });
  }
  const answer = body.answer.trim();
  if (!answer) return res.status(400).json({ error: 'Enter an answer before requesting evaluation.' });
  if (answer.length > MAX_ANSWER_LENGTH) {
    return res.status(413).json({ error: `Answers must be ${MAX_ANSWER_LENGTH} characters or fewer.` });
  }

  try {
    const record = await findOwnedResume(req);
    if (!record) return res.status(404).json({ error: 'Resume not found.' });
    const categoryKey = `${req.user.id}:${req.params.id}:${category.id}`;
    if (activeCategoryGenerations.has(categoryKey)) {
      return res.status(409).json({ error: 'This category is being regenerated. Try again when it is ready.' });
    }
    const practiceCategory = record.practice?.categories?.[category.id];
    const questions = practiceCategory?.questions;
    if (!practiceCategory || practiceCategory.status !== 'ready' || !Array.isArray(questions) || questions.length !== 6) {
      return res.status(409).json({ error: 'Generate this category\'s questions before submitting an answer.' });
    }
    const question = questions[questionIndex];
    if (!question || typeof question.question !== 'string' || !question.question.trim()) {
      return res.status(404).json({ error: 'Question not found.' });
    }

    const evaluationKey = `${categoryKey}:${questionIndex}`;
    if (activeAnswerEvaluations.has(evaluationKey)) {
      return res.status(409).json({ error: 'This answer is already being evaluated.' });
    }
    activeAnswerEvaluations.add(evaluationKey);
    const questionPath = `practice.categories.${category.id}.questions.${questionIndex}`;
    try {
      const result = await answerEvaluationService.evaluateAnswer({
        question: question.question,
        answer,
        categoryLabel: category.label,
        resumeContext: record.resumeContext,
      });
      const evaluation = {
        score: result.score,
        relevance: result.relevance,
        evidence: result.evidence,
        feedback: result.feedback,
        strengths: result.strengths,
        improvements: result.improvements,
        model: result.model,
        evaluatedAt: new Date(),
      };
      // Match the exact question text while writing so an evaluation that raced
      // with regeneration cannot be attached to a different question at this index.
      const update = await Resume.updateOne({
        _id: req.params.id,
        userId: req.user.id,
        [`${questionPath}.question`]: question.question,
      }, {
        $set: {
          [`${questionPath}.answer`]: answer,
          [`${questionPath}.evaluation`]: evaluation,
        },
      });
      if (update.matchedCount === 0) {
        return res.status(409).json({ error: 'This question changed while the answer was being evaluated. Please review the latest question and try again.' });
      }
      return res.json({ category: category.id, questionIndex, answer, evaluation });
    } catch (err) {
      // Preserve the candidate's answer even when Ollama is offline or returns
      // malformed output, so they can retry without losing what they typed.
      try {
        const draftUpdate = await Resume.updateOne({
          _id: req.params.id, userId: req.user.id, [`${questionPath}.question`]: question.question,
        }, { $set: { [`${questionPath}.answer`]: answer } });
        if (draftUpdate.matchedCount === 0) {
          return res.status(409).json({ error: 'This question changed while the answer was being evaluated. Please review the latest question and try again.' });
        }
      } catch {
        return res.status(500).json({ error: 'The answer could not be saved. Please try again.' });
      }
      const safeCode = String(err?.code || 'EVALUATION_FAILED').replace(/[^A-Z0-9_-]/gi, '').slice(0, 60);
      console.error(`[resumeController.evaluateAnswer] category=${category.id} questionIndex=${questionIndex} code=${safeCode}`);
      const invalidModelResponse = safeCode.startsWith('EVALUATION_INVALID') || safeCode === 'EVALUATION_EMPTY_RESPONSE';
      return res.status(invalidModelResponse ? 502 : 503).json({
        errorCode: invalidModelResponse ? 'invalid-evaluation' : 'evaluation-unavailable',
        error: invalidModelResponse
          ? 'The AI returned an evaluation that could not be validated. Please try again.'
          : 'Answer evaluation is temporarily unavailable. Check the local Ollama service and retry.',
      });
    } finally {
      activeAnswerEvaluations.delete(evaluationKey);
    }
  } catch {
    console.error('[resumeController.evaluateAnswer] Resume lookup or persistence failed.');
    return res.status(500).json({ error: 'Failed to evaluate the answer.' });
  }
}

module.exports = { uploadResume, getResume, getContext, getPractice, getQuestions, generateCategoryQuestions, evaluateAnswer };
