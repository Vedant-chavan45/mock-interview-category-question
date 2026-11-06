'use strict';

const axios = require('axios');
const { performance } = require('node:perf_hooks');

const ENDPOINT = 'https://api.groq.com/openai/v1/chat/completions';

function apiError(code, status, extra = {}) {
  const error = new Error(code); // Never expose upstream text or authorization headers.
  error.code = code;
  if (status !== undefined) error.status = status;
  Object.assign(error, extra);
  return error;
}

function durationInNs(seconds) {
  return typeof seconds === 'number' && Number.isFinite(seconds) && seconds >= 0
    ? Math.round(seconds * 1e9) : undefined;
}

function validOutputMode(env) {
  const choice = (env.GROQ_RESPONSE_FORMAT || 'json_schema').trim().toLowerCase();
  if (!['json_schema', 'json_object'].includes(choice)) {
    throw apiError('GROQ_INVALID_CONFIG');
  }
  return choice;
}

function formatResponse(schema, format, env) {
  if (!schema || typeof schema !== 'object') return { type: 'json_object' };
  if (validOutputMode(env) === 'json_object') return { type: 'json_object' };
  return {
    type: 'json_schema',
    json_schema: { name: 'interview_response', strict: false, schema },
  };
}

function requestedLimit(options, env) {
  const configured = Number(env.GROQ_MAX_COMPLETION_TOKENS);
  if (env.GROQ_MAX_COMPLETION_TOKENS && (!Number.isSafeInteger(configured) || configured < 128 || configured > 16384)) {
    throw apiError('GROQ_INVALID_CONFIG');
  }
  // Reasoning models consume some completion tokens on internal reasoning.
  // Preserve the source service's requested output budget, with a configurable headroom.
  const original = Number.isSafeInteger(options?.num_predict) && options.num_predict > 0
    ? options.num_predict : 512;
  return env.GROQ_MAX_COMPLETION_TOKENS ? configured : Math.max(original, 2048);
}

async function generateStructured({
  prompt, schema, format, model, options = {}, timeoutMs = 120000, signal, onFirstChunk,
}) {
  const env = process.env;
  const key = env.GROQ_API_KEY?.trim();
  if (!key) throw apiError('GROQ_API_KEY_MISSING');
  if (!model || typeof model !== 'string') throw apiError('GROQ_MODEL_MISSING');
  if (signal?.aborted) throw apiError('ERR_CANCELED');
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw apiError('GROQ_INVALID_CONFIG');

  const reasoningEffort = (env.GROQ_REASONING_EFFORT || 'medium').trim().toLowerCase();
  if (!['low', 'medium', 'high'].includes(reasoningEffort)) throw apiError('GROQ_INVALID_CONFIG');
  const body = {
    model,
    messages: [{ role: 'user', content: prompt }],
    stream: false, // JSON Schema Structured Outputs does not support streaming on Groq.
    response_format: formatResponse(schema, format, env),
    max_completion_tokens: requestedLimit(options, env),
  };
  if (typeof options.temperature === 'number' && Number.isFinite(options.temperature)) {
    body.temperature = options.temperature;
  }
  if (model.startsWith('openai/gpt-oss-')) body.reasoning_effort = reasoningEffort;

  const startedAt = performance.now();
  const controller = new AbortController();
  let timedOut = false;
  let callerCancelled = false;
  const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  const onCancel = () => { callerCancelled = true; controller.abort(); };
  signal?.addEventListener('abort', onCancel, { once: true });
  try {
    const result = await axios.post(ENDPOINT, body, {
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      timeout: timeoutMs,
      signal: controller.signal,
    });
    const message = result?.data?.choices?.[0]?.message;
    const reason = result?.data?.choices?.[0]?.finish_reason;
    if (reason === 'length') throw apiError('GROQ_OUTPUT_LIMIT', result?.status);
    if (reason !== 'stop' || typeof message?.content !== 'string' || !message.content.trim()) {
      throw apiError('GROQ_INVALID_RESPONSE', result?.status);
    }
    const usage = result.data?.usage || {};
    const timing = usage.timings || usage;
    const promptTime = durationInNs(timing.prompt_time);
    const completionTime = durationInNs(timing.completion_time);
    const totalTime = durationInNs(timing.total_time);
    // A complete buffered response is all that structured mode can return.
    // This callback signals first available content, not first-token latency.
    onFirstChunk?.();
    return {
      response: message.content,
      status: result.status,
      done: true,
      doneReason: 'stop',
      evalCount: usage.completion_tokens,
      promptEvalCount: usage.prompt_tokens,
      promptEvalDuration: promptTime,
      evalDuration: completionTime,
      totalDuration: totalTime,
      firstChunkMs: Math.max(0, performance.now() - startedAt),
    };
  } catch (error) {
    if (timedOut || (error?.code === 'ECONNABORTED' && !callerCancelled)) throw apiError('ECONNABORTED');
    if (callerCancelled || signal?.aborted) throw apiError('ERR_CANCELED');
    if (error?.code?.startsWith('GROQ_')) throw error;
    const status = error?.response?.status;
    if (status === 429) {
      const retrySeconds = Number(error.response.headers?.['retry-after']);
      throw apiError('GROQ_RATE_LIMITED', status,
        Number.isFinite(retrySeconds) && retrySeconds >= 0 ? { retryAfterSeconds: Math.min(retrySeconds, 86400) } : {});
    }
    if (status === 401 || status === 403) throw apiError('GROQ_AUTH_FAILED', status);
    if (status === 404) throw apiError('GROQ_MODEL_UNAVAILABLE', status);
    if (status === 400 || status === 422) throw apiError('GROQ_REQUEST_REJECTED', status);
    if (typeof status === 'number') throw apiError('GROQ_API_ERROR', status);
    throw apiError('GROQ_NETWORK_ERROR');
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', onCancel);
  }
}

module.exports = { generateStructured };
