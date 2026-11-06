'use strict';

const { randomUUID } = require('node:crypto');

const OPERATIONS = new Set(['resume_analysis', 'category_generation', 'answer_evaluation']);
const STAGES = new Set(['planning', 'generation', 'review', 'repair', 'quality-review', 'quality-repair', 'evaluation', 'resume_analysis', 'end_to_end']);
const CATEGORIES = new Set([
  'domain_fundamentals', 'technical_concepts', 'project_deep_dive',
  'professional_experience', 'applied_scenarios', 'behavioral_collaboration',
]);
const OUTCOMES = new Set(['success', 'failure', 'bypass', 'cache_hit', 'fallback']);
const observers = new Set();

function observe(callback) {
  if (typeof callback !== 'function') throw new TypeError('Telemetry observer must be a function.');
  observers.add(callback);
  return () => observers.delete(callback);
}

function createRequestId() {
  return randomUUID();
}

function nanosecondsToMilliseconds(value) {
  return Number.isSafeInteger(value) && value >= 0
    ? Math.round((value / 1e6) * 1000) / 1000
    : null;
}

function safeLabel(value, pattern, fallback = null) {
  return typeof value === 'string' && pattern.test(value) ? value : fallback;
}

function safeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function safeMilliseconds(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.round(value * 1000) / 1000
    : null;
}

function safeModelOptions(options, keepAlive) {
  const result = {};
  if (Number.isSafeInteger(options?.num_predict) && options.num_predict > 0) result.numPredict = options.num_predict;
  if (Number.isSafeInteger(options?.num_ctx) && options.num_ctx > 0) result.numContext = options.num_ctx;
  if (typeof options?.temperature === 'number' && Number.isFinite(options.temperature) && options.temperature >= 0 && options.temperature <= 2) {
    result.temperature = options.temperature;
  }
  if (typeof keepAlive === 'string' && /^(?:-1|0|[1-9][0-9]*(?:ms|s|m|h))$/.test(keepAlive)) result.keepAlive = keepAlive;
  return Object.keys(result).length ? result : null;
}

function failureCategory(error) {
  const code = typeof error?.code === 'string' ? error.code : '';
  if (code === 'AI_PROVIDER_UNSUPPORTED') return 'unsupported_provider';
  if (code === 'QUESTION_QUALITY_REJECTED') return 'quality_rejected';
  if (code === 'ECONNABORTED' || code === 'ETIMEDOUT' || code.includes('TIMEOUT')) return 'timeout';
  if (code === 'ERR_CANCELED' || code === 'ABORT_ERR') return 'cancelled';
  if (code.includes('INVALID') || code.includes('EMPTY') || code.includes('INCOMPLETE')) return 'invalid_response';
  if (code.startsWith('ECONN') || code === 'ENOTFOUND' || code === 'EHOSTUNREACH') return 'network_error';
  return 'provider_error';
}

function buildInferenceEvent({
  requestId = createRequestId(), operation, provider, model, categoryId, stage,
  outcome = 'success', error, elapsedMs, firstChunkMs, loadDuration,
  promptEvalDuration, evalDuration, totalDuration, promptEvalCount, evalCount,
  retryCount = 0, modelOptions,
}) {
  const normalizedOutcome = OUTCOMES.has(outcome) ? outcome : 'failure';
  return {
    event: 'ai.inference',
    requestId: safeLabel(requestId, /^[0-9a-f-]{36}$/i, createRequestId()),
    operation: OPERATIONS.has(operation) ? operation : 'resume_analysis',
    provider: safeLabel(provider, /^[a-z0-9][a-z0-9_-]{0,31}$/i, 'unknown'),
    model: safeLabel(model, /^[a-z0-9][a-z0-9._:/@-]{0,119}$/i, 'unknown'),
    categoryId: CATEGORIES.has(categoryId) ? categoryId : null,
    stage: STAGES.has(stage) ? stage : null,
    outcome: normalizedOutcome,
    failureCategory: normalizedOutcome === 'failure' ? failureCategory(error) : null,
    elapsedMs: safeMilliseconds(elapsedMs),
    timeToFirstChunkMs: safeMilliseconds(firstChunkMs),
    loadMs: nanosecondsToMilliseconds(loadDuration),
    promptProcessingMs: nanosecondsToMilliseconds(promptEvalDuration),
    decodeMs: nanosecondsToMilliseconds(evalDuration),
    modelTotalMs: nanosecondsToMilliseconds(totalDuration),
    promptTokens: safeInteger(promptEvalCount),
    generatedTokens: safeInteger(evalCount),
    retryCount: safeInteger(retryCount) ?? 0,
    modelOptions: safeModelOptions(modelOptions?.options, modelOptions?.keepAlive),
  };
}

function buildOperationEvent({
  requestId = createRequestId(), operation, provider = 'ollama', model,
  categoryId, stage = 'end_to_end', outcome = 'success', error, elapsedMs,
  queueWaitMs, cacheHit, validationMs, repairCount, repairMs, planningMs,
  reviewMs, modelCallCount, requestMs, firstChunkMs, loadMs,
  promptProcessingMs, decodeMs, modelTotalMs, promptTokens, generatedTokens,
  retryCount, modelOptions,
}) {
  const event = buildInferenceEvent({
    requestId, operation, provider, model, categoryId, stage, outcome, error,
    elapsedMs, firstChunkMs, loadDuration: null, promptEvalDuration: null,
    evalDuration: null, totalDuration: null, promptEvalCount: null, evalCount: null,
    retryCount, modelOptions,
  });
  return {
    ...event,
    event: 'ai.operation',
    queueWaitMs: safeMilliseconds(queueWaitMs),
    cacheHit: typeof cacheHit === 'boolean' ? cacheHit : null,
    validationMs: safeMilliseconds(validationMs),
    repairCount: safeInteger(repairCount),
    repairMs: safeMilliseconds(repairMs),
    planningMs: safeMilliseconds(planningMs),
    reviewMs: safeMilliseconds(reviewMs),
    modelCallCount: safeInteger(modelCallCount),
    requestMs: safeMilliseconds(requestMs),
    loadMs: safeMilliseconds(loadMs),
    promptProcessingMs: safeMilliseconds(promptProcessingMs),
    decodeMs: safeMilliseconds(decodeMs),
    modelTotalMs: safeMilliseconds(modelTotalMs),
    promptTokens: safeInteger(promptTokens),
    generatedTokens: safeInteger(generatedTokens),
  };
}

function emit(event, env = process.env) {
  for (const observer of observers) {
    try { observer(event); } catch { /* observers cannot interrupt requests */ }
  }
  if (env.AI_PERF_LOG_ENABLED !== '1') return false;
  try {
    console.log(JSON.stringify(event));
    return true;
  } catch {
    // Telemetry must never interrupt an inference request.
    return false;
  }
}

function recordInference(details, env = process.env) {
  return emit(buildInferenceEvent(details), env);
}

function recordOperation(details, env = process.env) {
  return emit(buildOperationEvent(details), env);
}

module.exports = {
  buildInferenceEvent,
  buildOperationEvent,
  createRequestId,
  emit,
  failureCategory,
  nanosecondsToMilliseconds,
  observe,
  recordInference,
  recordOperation,
};
