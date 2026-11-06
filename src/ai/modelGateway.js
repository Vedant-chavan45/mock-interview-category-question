'use strict';

const { performance } = require('node:perf_hooks');
const { getAIConfig } = require('./config');
const telemetry = require('./telemetry');
const ollamaProvider = require('./providers/ollamaProvider');
const groqProvider = require('./providers/groqProvider');

const providers = new Map([['ollama', ollamaProvider], ['groq', groqProvider]]);

function registerProvider(name, provider) {
  if (typeof name !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,31}$/i.test(name) ||
      typeof provider?.generateStructured !== 'function') {
    throw new TypeError('A provider name and generateStructured implementation are required.');
  }
  providers.set(name.toLowerCase(), provider);
}

async function generateStructured(request) {
  const startedAt = performance.now();
  const { provider: providerName } = getAIConfig();
  const provider = providers.get(providerName);
  const requestId = telemetry.createRequestId();
  let firstChunkMs = null;
  const onFirstChunk = () => {
    if (firstChunkMs === null) firstChunkMs = Math.max(0, performance.now() - startedAt);
    request.onFirstChunk?.();
  };
  const metadata = {
    requestId,
    operation: request.operation,
    provider: provider ? providerName : 'unsupported',
    model: request.model,
    categoryId: request.categoryId,
    stage: request.stage,
    retryCount: request.retryCount,
    modelOptions: { options: request.options, keepAlive: request.keepAlive },
  };

  if (!provider) {
    const error = Object.assign(new Error(`Unsupported AI provider: ${providerName}`), { code: 'AI_PROVIDER_UNSUPPORTED' });
    telemetry.recordInference({ ...metadata, outcome: 'failure', error, elapsedMs: performance.now() - startedAt });
    throw error;
  }

  try {
    const response = await provider.generateStructured({ ...request, onFirstChunk });
    const elapsedMs = Math.max(0, performance.now() - startedAt);
    const modelTimings = {
      firstChunkMs: response.firstChunkMs ?? firstChunkMs,
      elapsedMs,
      retryCount: Number.isSafeInteger(request.retryCount) && request.retryCount >= 0 ? request.retryCount : 0,
    };
    telemetry.recordInference({
      ...metadata,
      outcome: 'success',
      elapsedMs,
      firstChunkMs: modelTimings.firstChunkMs,
      loadDuration: response.loadDuration,
      promptEvalDuration: response.promptEvalDuration,
      evalDuration: response.evalDuration,
      totalDuration: response.totalDuration,
      promptEvalCount: response.promptEvalCount,
      evalCount: response.evalCount,
    });
    return {
      ...response,
      provider: providerName,
      model: request.model,
      telemetry: modelTimings,
    };
  } catch (error) {
    telemetry.recordInference({
      ...metadata,
      outcome: 'failure',
      error,
      elapsedMs: Math.max(0, performance.now() - startedAt),
      firstChunkMs,
    });
    throw error;
  }
}

module.exports = { generateStructured, registerProvider };
