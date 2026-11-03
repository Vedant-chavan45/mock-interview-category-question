const mongoose = require('mongoose');
const Resume = require('../models/Resume');
const pdfService = require('../services/pdfService');
const resumeParserService = require('../services/resumeParserService');
const ollamaService = require('../services/ollamaService');
const contextBuilder = require('../services/contextBuilder');
const questionGeneratorService = require('../services/questionGeneratorService');
const answerEvaluationService = require('../services/answerEvaluationService');
const { getQuestionCategory } = require('../services/questionCategories');
const { detectCoveredSkills, normalizeHistory, buildCoverageLedger } = require('../services/questionRotationService');

const activeCategoryGenerations = new Set();
const activeAnswerEvaluations = new Set();
const MAX_ANSWER_LENGTH = 8000;
const MAX_REQUIRED_SKILLS = 20;
const MAX_SKILL_LENGTH = 80;

/**
 * Accept the requiredSkillset sent by the frontend as a JSON string
 * (multipart/form-data) or as an array (for other compatible callers).
 * Normalize whitespace and remove duplicate skills case-insensitively.
 */
function parseRequiredSkillset(value) {
  let skills;

  try {
    skills = Array.isArray(value) ? value : JSON.parse(value);
  } catch {
    const error = new Error('Required skillset must be a valid JSON array.');
    error.statusCode = 400;
    throw error;
  }

  if (!Array.isArray(skills)) {
    const error = new Error('Required skillset must be an array.');
    error.statusCode = 400;
    throw error;
  }

  if (skills.length === 0) {
    const error = new Error('Select at least one required skill.');
    error.statusCode = 400;
    throw error;
  }

  if (skills.length > MAX_REQUIRED_SKILLS) {
    const error = new Error(`Select no more than ${MAX_REQUIRED_SKILLS} skills.`);
    error.statusCode = 400;
    throw error;
  }

  const normalized = [];
  const seen = new Set();

  for (const skill of skills) {
    if (typeof skill !== 'string' || !skill.trim()) {
      const error = new Error('Every required skill must be a non-empty string.');
      error.statusCode = 400;
      throw error;
    }

    const clean = skill.trim();

    if (clean.length > MAX_SKILL_LENGTH) {
      const error = new Error(`Each skill must be ${MAX_SKILL_LENGTH} characters or fewer.`);
      error.statusCode = 400;
      throw error;
    }

    const key = clean.toLowerCase();

    if (!seen.has(key)) {
      seen.add(key);
      normalized.push(clean);
    }
  }

  return normalized;
}

async function uploadResume(req, res) {
  try {
    if (!mongoose.isObjectIdOrHexString(req.user.id)) {
      return res.status(401).json({
        error: 'Invalid user identity. Please log in again.',
      });
    }

    const targetRole = typeof req.body?.targetRole === 'string'
      ? req.body.targetRole.trim()
      : '';

    if (!targetRole) {
      return res.status(400).json({
        error: 'Please select a target role.',
      });
    }

    if (targetRole.length > 120) {
      return res.status(400).json({
        error: 'Target role must be 120 characters or fewer.',
      });
    }

    const requiredSkillset = parseRequiredSkillset(req.body?.requiredSkillset);

    pdfService.validateFile(req.file);
    const { text, pageCount } = await pdfService.extractText(req.file.buffer);
    const parsedResume = resumeParserService.parse(text);
    const analysis = await ollamaService.analyseResume(parsedResume);

    // Preserve the existing internal interview type while the UI uses
    // Required Skillset as the question-prioritization input.
    const resumeContext = contextBuilder.build(parsedResume, analysis, {
      interviewType: 'Technical',
      targetRole,
      requiredSkillset,
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

    if (err.statusCode === 400) {
      return res.status(400).json({ error: err.message });
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

/** Keep diagnosis actionable without returning model output, resume text, or secrets. */
function classifyQuestionGenerationFailure(err) {
  const code = String(err?.code || '');
  const status = err?.response?.status ?? err?.status;
  if (['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH', 'ERR_NETWORK'].includes(code)) {
    return { status: 503, errorCode: 'ollama-unreachable',
      error: 'Cannot connect to the configured Ollama server. Run npm run check:ollama to diagnose the connection.' };
  }
  if (status === 404) {
    return { status: 502, errorCode: 'ollama-model-not-found',
      error: 'Ollama could not find the configured model. Run ollama list and compare it with OLLAMA_MODEL in .env.' };
  }
  if (status === 400 || status === 422) {
    return { status: 502, errorCode: 'ollama-request-rejected',
      error: 'Ollama rejected the generation request. Check model compatibility and run npm run check:ollama.' };
  }
  if (['QUESTION_GENERATION_TIMEOUT', 'ECONNABORTED', 'ETIMEDOUT'].includes(code)) {
    return { status: 504, errorCode: 'ollama-timeout',
      error: 'The local AI model took too long to generate and review the questions. Check Ollama performance and QUESTION_GENERATION_TIMEOUT_MS.' };
  }
  if (['OLLAMA_OUTPUT_LIMIT', 'OLLAMA_INCOMPLETE_STREAM', 'OLLAMA_EMPTY_RESPONSE', 'OLLAMA_INVALID_RESPONSE',
    'INVALID_SKILL_PLAN', 'INVALID_QUALITY_REVIEW', 'QUESTION_QUALITY_REJECTED'].includes(code) ||
      err?.message === 'Invalid generated questions.' || err?.diagnosticReason?.includes('question-validation-error') ||
      err instanceof SyntaxError) {
    return { status: 502, errorCode: 'invalid-generation',
      error: code === 'OLLAMA_OUTPUT_LIMIT'
        ? 'Ollama stopped before completing the structured response. Try a faster or more capable model, or increase the generation context and token limits.'
        : 'Ollama returned an incomplete or invalid question set. The previous questions were preserved. Check the server diagnostics.' };
  }
  return { status: 503, errorCode: 'generation-failed',
    error: 'AI question generation failed. Check the backend terminal for its error code, then run npm run check:ollama.' };
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
      const existing = record.practice?.categories?.[category.id];
      const historicalSets = normalizeHistory(existing?.history);
      if (Array.isArray(existing?.questions) && existing.questions.length) {
        historicalSets.push({
          questions: existing.questions.map((question) => ({ ...question })),
          skillsCovered: Array.isArray(existing.skillsCovered) ? existing.skillsCovered : [],
          coverage: Array.isArray(existing.coverage) ? existing.coverage : [],
          generationNumber: Number.isInteger(existing.generationNumber) ? existing.generationNumber : undefined,
        });
      }
      const force = req.get?.('X-Regenerate') === 'true' ||
        req.headers?.['x-regenerate'] === 'true' || historicalSets.length > 0;
      const result = await questionGeneratorService.generateCategoryQuestions(record.resumeContext, category.id,
        { force, signal: generation.signal, history: historicalSets });
      if (result?.status !== 'ready' || result.source !== `ollama-${result.model}` ||
          !Array.isArray(result.questions) || result.questions.length !== 6) {
        return res.status(502).json({ category: category.id, status: 'failed', errorCode: 'invalid-generation',
          error: 'Question generation did not produce a validated AI question set. Retry to try again.' });
      }
      const generationNumber = Number.isInteger(existing?.generationNumber)
        ? existing.generationNumber + 1 : historicalSets.length + 1;
      const skillsCovered = detectCoveredSkills(result.questions, record.resumeContext.requiredSkillset);
      const coverage = result.questions.map((question) => ({
        primaryRequiredSkill: question.primaryRequiredSkill || '',
        primaryAssessmentTarget: question.primaryAssessmentTarget || '',
        subtopic: question.subtopic || '',
        assessmentObjective: question.assessmentObjective || '',
        coverageSignature: question.coverageSignature || '',
      })).filter((entry) => entry.primaryRequiredSkill || entry.primaryAssessmentTarget);
      const savedCategory = {
        categoryId: category.id,
        model: result.model,
        source: result.source,
        status: result.status,
        metrics: result.metrics,
        generatedAt: new Date(),
        questions: result.questions.map((question) => ({ ...question, answer: '', evaluation: null })),
        skillsCovered,
        coverage,
        coverageLedger: buildCoverageLedger(historicalSets, record.resumeContext.requiredSkillset, result.questions, generationNumber),
        generationNumber,
        history: historicalSets.slice(-29).map((set) => ({
          questions: set.questions,
          skillsCovered: set.skillsCovered,
          coverage: set.coverage,
          generationNumber: set.generationNumber,
        })),
      };
      const update = await Resume.updateOne(
        { _id: req.params.id, userId: req.user.id },
        { $set: { [`practice.categories.${category.id}`]: savedCategory } },
      );
      if (update.matchedCount === 0) return res.status(404).json({ error: 'Resume not found.' });
      return res.json({ ...result, category: category.id, questions: savedCategory.questions,
        skillsCovered: savedCategory.skillsCovered, coverage: savedCategory.coverage,
        coverageLedger: savedCategory.coverageLedger, generationNumber: savedCategory.generationNumber });
    } catch (err) {
      if (generation.signal.aborted) return undefined;
      if (err?.code === 'INSUFFICIENT_RESUME_EVIDENCE') {
        return res.status(422).json({ category: category.id, status: 'insufficient-evidence',
          errorCode: 'insufficient-evidence', error: 'This resume does not contain enough documented evidence for this category.' });
      }
      const classified = classifyQuestionGenerationFailure(err);
      // Never log raw prompts or model responses: they can contain candidate résumé data.
      const safeReason = String(err?.diagnosticReason || err?.code || err?.name || 'unknown')
        .replace(/[\r\n]+/g, ' ').slice(0, 240);
      console.error(`[resumeController.generateCategoryQuestions] category=${category.id} errorCode=${classified.errorCode} cause=${safeReason} upstreamStatus=${err?.response?.status || 'none'}`);
      return res.status(classified.status).json({ category: category.id, status: 'failed',
        errorCode: classified.errorCode, error: classified.error });
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

module.exports = {
  uploadResume,
  getResume,
  getContext,
  getPractice,
  getQuestions,
  generateCategoryQuestions,
  evaluateAnswer,
};
