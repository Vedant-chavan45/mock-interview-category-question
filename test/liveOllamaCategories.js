'use strict';

// Manual integration run: node test/liveOllamaCategories.js
require('dotenv').config();
process.env.DEBUG_QUESTION_GENERATION = '1';
const axios = require('axios');
const contextBuilder = require('../src/services/contextBuilder');
const { QUESTION_CATEGORIES } = require('../src/services/questionCategories');
const { generateCategoryQuestions, buildCategoryQuestionPrompt } = require('../src/services/questionGeneratorService');
const fixture = require('./fixtures/syntheticInterviewResume');

function qualityDiagnostics(questions) {
  const wordCounts = questions.map((question) => String(question).trim().split(/\s+/).filter(Boolean).length);
  const normalized = questions.map((question) => String(question).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' '));
  return {
    wordCounts,
    averageWords: Number((wordCounts.reduce((sum, count) => sum + count, 0) / Math.max(wordCounts.length, 1)).toFixed(1)),
    maxWords: Math.max(0, ...wordCounts),
    above18Words: wordCounts.filter((count) => count > 18).length,
    duplicateQuestions: normalized.length - new Set(normalized).size,
  };
}

async function main() {
  const baseUrl = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
  const model = process.env.OLLAMA_MODEL || 'llama3.2';
  const tags = await axios.get(`${baseUrl}/api/tags`, { timeout: 5000 });
  const installed = (tags.data?.models || []).map((item) => item.name).filter(Boolean);
  const modelAvailable = installed.some((name) => name === model || name === `${model}:latest` || `${name}`.replace(/:latest$/, '') === model);
  if (!modelAvailable) throw new Error(`Configured Ollama model is unavailable: ${model}`);

  const resumeContext = contextBuilder.build(fixture.parsedResume, fixture.analysis, {
    targetRole: fixture.targetRole, interviewType: fixture.interviewType,
  });
  console.log(JSON.stringify({ stage: 'preflight', ollamaReachable: true, configuredModel: model,
    installedModel: installed.find((name) => name === model || name === `${model}:latest` || name.replace(/:latest$/, '') === model),
    fixture: 'syntheticInterviewResume', targetRole: fixture.targetRole, categories: Object.keys(QUESTION_CATEGORIES).length,
    promptChars: Object.fromEntries(Object.keys(QUESTION_CATEGORIES).map((id) => [id, buildCategoryQuestionPrompt(resumeContext, id).length])) }));

  const reports = [];
  for (const category of Object.values(QUESTION_CATEGORIES)) {
    const startedAt = Date.now();
    try {
      const result = await generateCategoryQuestions(resumeContext, category.id, { force: true });
      if (result.status !== 'ready' || result.source !== `ollama-${result.model}` || !Array.isArray(result.questions) || result.questions.length !== 6) {
        throw Object.assign(new Error('The category did not return six validated Ollama questions.'), { code: 'INVALID_AI_RESULT' });
      }
      const questions = result.questions.map((item) => item.question);
      const report = { category: category.label, categoryId: category.id, source: result.source, model: result.model,
        durationMs: Date.now() - startedAt, metrics: result.metrics, validation: 'passed', repairCount: result.metrics?.repairCount || 0,
        readability: qualityDiagnostics(questions), questions };
      reports.push(report);
      console.log(JSON.stringify({ stage: 'category-result', ...report }));
    } catch (error) {
      const report = { category: category.label, categoryId: category.id, source: 'none', model,
        durationMs: Date.now() - startedAt, validation: 'failed', repairCount: error.repairPerformed ? 1 : 0,
        rejectionReason: error.diagnosticReason || error.code || error.message,
        questionIndex: Number.isSafeInteger(error.questionIndex) ? error.questionIndex : undefined,
        slotId: error.slotId || undefined,
        rejectedQuestion: error.rejectedQuestion || undefined,
        rejectedQuestions: Array.isArray(error.rejectedQuestions) ? error.rejectedQuestions : undefined };
      reports.push(report);
      console.log(JSON.stringify({ stage: 'category-result', ...report }));
    }
  }

  const accepted = reports.filter((item) => item.validation === 'passed');
  const totalDurationMs = reports.reduce((total, item) => total + item.durationMs, 0);
  console.log(JSON.stringify({ stage: 'summary', acceptedCategories: accepted.length, totalCategories: reports.length,
    totalDurationMs, averageCategoryMs: Math.round(totalDurationMs / Math.max(reports.length, 1)),
    slowestCategoryMs: Math.max(0, ...reports.map((item) => item.durationMs)),
    averageQuestionWords: accepted.length ? Number((accepted.reduce((sum, item) => sum + item.readability.averageWords, 0) / accepted.length).toFixed(1)) : null,
    previousReportedBaselineMs: '48000-64000 per category (user-reported, not measured in this run)',
    passed: accepted.length === reports.length }));
  if (accepted.length !== reports.length) process.exitCode = 1;
}

main().catch((error) => {
  console.error(JSON.stringify({ stage: 'preflight-failed', error: error.code || 'ollama-unavailable', message: error.message }));
  process.exitCode = 1;
});
