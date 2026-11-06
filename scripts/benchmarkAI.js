'use strict';

// The web server also loads its local configuration from .env. Load those settings
// only for direct CLI execution, before the service modules snapshot model options.
if (require.main === module) require('dotenv').config();

const fs = require('node:fs');
const crypto = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { getQuestionCategory, QUESTION_CATEGORIES } = require('../src/services/questionCategories');
const contextBuilder = require('../src/services/contextBuilder');
const questionGenerator = require('../src/services/questionGeneratorService');
const answerEvaluation = require('../src/services/answerEvaluationService');
const telemetry = require('../src/ai/telemetry');
const { parsedResume, analysis, targetRole, interviewType } = require('../test/fixtures/syntheticInterviewResume');

function parseArgs(argv) {
  const options = { category: 'domain_fundamentals', runs: 1, dryRun: false, includeEvaluation: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--dry-run') options.dryRun = true;
    else if (argument === '--include-evaluation') options.includeEvaluation = true;
    else if (argument === '--category' || argument === '--runs') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`Missing value for ${argument}`);
      index += 1;
      if (argument === '--category') options.category = value;
      else options.runs = Number(value);
    } else throw new Error(`Unknown option: ${argument}`);
  }
  const categoryIds = Object.keys(QUESTION_CATEGORIES);
  if (options.category !== 'all' && !categoryIds.includes(options.category)) {
    throw new Error(`Invalid category. Choose one of: ${categoryIds.join(', ')}, all.`);
  }
  if (!Number.isSafeInteger(options.runs) || options.runs < 1 || options.runs > 100) {
    throw new Error('--runs must be an integer from 1 through 100.');
  }
  options.categories = options.category === 'all' ? categoryIds : [options.category];
  return options;
}

function buildSyntheticContext() {
  return contextBuilder.build(parsedResume, analysis, {
    interviewType,
    targetRole,
    requiredSkillset: ['Node.js', 'Express', 'MongoDB'],
  });
}

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function safeErrorCode(error) {
  return typeof error?.code === 'string' && /^[A-Z0-9_-]{1,64}$/.test(error.code)
    ? error.code : 'BENCHMARK_RUN_FAILED';
}

function statistics(values) {
  const sorted = values.slice().sort((left, right) => left - right);
  if (!sorted.length) return { sampleCount: 0, minMs: null, meanMs: null, medianMs: null, p95Ms: null, p95Exploratory: true };
  const middle = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  const p95 = sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)];
  return {
    sampleCount: sorted.length,
    minMs: sorted[0],
    meanMs: Number((sorted.reduce((sum, value) => sum + value, 0) / sorted.length).toFixed(3)),
    medianMs: Number(median.toFixed(3)),
    p95Ms: Number(p95.toFixed(3)),
    p95Exploratory: sorted.length < 20,
  };
}

function runMetadata() {
  const metadata = questionGenerator.benchmarkMetadata();
  const provider = (process.env.AI_PROVIDER || 'ollama').toLowerCase();
  return {
    provider: /^[a-z0-9][a-z0-9_-]{0,31}$/.test(provider) ? provider : 'unsupported',
    model: metadata.model,
    generationMode: metadata.generationMode,
    promptVersion: metadata.promptVersion,
    validatorSha256: sha256File(require.resolve('../src/services/questionValidatorService')),
    configuredModelOptions: metadata.configuredModelOptions,
  };
}

function dryRun(options) {
  const resumeContext = buildSyntheticContext();
  const summary = {
    benchmark: 'AI Interview Studio local benchmark',
    mode: 'dry-run',
    preflight: 'passed',
    inferencePerformed: false,
    databaseRequired: false,
    syntheticFixture: 'test/fixtures/syntheticInterviewResume.js',
    categoryIds: options.categories,
    runsPerCategory: options.runs,
    resumeContextReady: Boolean(resumeContext.targetRole && resumeContext.projects.length && resumeContext.experience.length),
    includeEvaluation: options.includeEvaluation,
    metadata: runMetadata(),
  };
  console.log(JSON.stringify(summary, null, 2));
}

function runMetrics(result, wallMs, categoryId, run, modelCalls) {
  const metrics = result.metrics || {};
  const retryCount = modelCalls.reduce((sum, call) => sum + (call.retryCount || 0), 0);
  return {
    operation: 'category_generation',
    category: categoryId,
    run,
    outcome: result.status === 'ready' ? 'success' : 'invalid_output',
    wallMs: Number(wallMs.toFixed(3)),
    queueWaitMs: metrics.queueWaitMs ?? null,
    requestMs: metrics.requestMs ?? null,
    modelTimingsMs: {
      load: metrics.modelLoadMs ?? null,
      promptProcessing: metrics.promptEvalMs ?? null,
      decode: metrics.outputGenerationMs ?? null,
      total: metrics.modelTotalMs ?? null,
    },
    promptTokens: metrics.promptTokens ?? null,
    generatedTokens: metrics.outputTokens ?? null,
    retries: retryCount,
    modelCalls,
    validationMs: metrics.validationMs ?? null,
    repairCount: metrics.repairCount ?? 0,
    repairMs: metrics.repairMs ?? null,
    cacheHit: metrics.cacheHit === true,
    model: result.model,
    source: result.source,
    questionCount: Array.isArray(result.questions) ? result.questions.length : 0,
    questions: Array.isArray(result.questions) ? result.questions.map((item) => item.question) : [],
  };
}

async function liveRun(options) {
  const resumeContext = buildSyntheticContext();
  const runs = [];
  let failed = false;
  for (const categoryId of options.categories) {
    for (let run = 1; run <= options.runs; run += 1) {
      const startedAt = performance.now();
      const modelCalls = [];
      const stopObserving = telemetry.observe((event) => {
        if (event.event === 'ai.inference' && event.operation === 'category_generation' && event.categoryId === categoryId) {
          modelCalls.push(event);
        }
      });
      try {
        const result = await questionGenerator.generateCategoryQuestions(resumeContext, categoryId, { force: true });
        stopObserving();
        const report = runMetrics(result, performance.now() - startedAt, categoryId, run, modelCalls);
        runs.push(report);
        if (report.outcome !== 'success' || report.questionCount !== 6) failed = true;
      } catch (error) {
        stopObserving();
        failed = true;
        runs.push({
          operation: 'category_generation', category: categoryId, run,
          outcome: 'failure', wallMs: Number((performance.now() - startedAt).toFixed(3)),
          errorCode: safeErrorCode(error), modelCalls,
        });
      }
    }
  }

  let evaluation = null;
  if (options.includeEvaluation) {
    const firstSuccessfulRun = runs.find((run) => run.outcome === 'success' && run.questions?.length);
    if (!firstSuccessfulRun) {
      failed = true;
      evaluation = { operation: 'answer_evaluation', outcome: 'skipped', errorCode: 'NO_SUCCESSFUL_GENERATION' };
    } else {
      const category = getQuestionCategory(firstSuccessfulRun.category);
      const startedAt = performance.now();
      const modelCalls = [];
      const stopObserving = telemetry.observe((event) => {
        if (event.event === 'ai.inference' && event.operation === 'answer_evaluation' && event.categoryId === category.id) {
          modelCalls.push(event);
        }
      });
      try {
        const result = await answerEvaluation.evaluateAnswer({
          question: firstSuccessfulRun.questions[0],
          answer: 'I would validate the request, return a clear error for missing fields, and test both valid and invalid inputs.',
          categoryLabel: category.label,
          categoryId: category.id,
          resumeContext,
        });
        stopObserving();
        evaluation = {
          operation: 'answer_evaluation', category: category.id, outcome: 'success',
          wallMs: Number((performance.now() - startedAt).toFixed(3)),
          score: result.score, relevance: result.relevance, model: result.model, modelCalls,
        };
      } catch (error) {
        stopObserving();
        failed = true;
        evaluation = {
          operation: 'answer_evaluation', category: category.id, outcome: 'failure',
          wallMs: Number((performance.now() - startedAt).toFixed(3)), errorCode: safeErrorCode(error), modelCalls,
        };
      }
    }
  }

  const successfulWallTimes = runs.filter((run) => run.outcome === 'success').map((run) => run.wallMs);
  const aggregateByCategory = Object.fromEntries(options.categories.map((categoryId) => [
    categoryId,
    statistics(runs.filter((run) => run.category === categoryId && run.outcome === 'success').map((run) => run.wallMs)),
  ]));
  const report = {
    benchmark: 'AI Interview Studio local benchmark',
    mode: 'live',
    inferencePerformed: true,
    databaseRequired: false,
    syntheticFixture: 'test/fixtures/syntheticInterviewResume.js',
    runs,
    evaluation,
    aggregateByCategory,
    aggregateWallTime: statistics(successfulWallTimes),
    metadata: runMetadata(),
    note: 'p95 is exploratory when sampleCount is below 20. Generation output is shown for human review; automated validation does not prove semantic quality.',
  };
  console.log(JSON.stringify(report, null, 2));
  if (failed) process.exitCode = 1;
}

async function main(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    console.error(`${error.message}\nUsage: npm run benchmark:ai -- [--category <id|all>] [--runs N] [--include-evaluation] [--dry-run]`);
    process.exitCode = 2;
    return;
  }
  if (options.dryRun) dryRun(options);
  else await liveRun(options);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`Benchmark failed: ${safeErrorCode(error)}`);
    process.exitCode = 1;
  });
}

module.exports = { buildSyntheticContext, main, parseArgs, statistics };
