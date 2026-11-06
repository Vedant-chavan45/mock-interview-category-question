'use strict';

const axios = require('axios');
const { StringDecoder } = require('node:string_decoder');
const { performance } = require('node:perf_hooks');

function getBaseUrl() {
  return (process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434').replace(/\/+$/, '');
}

function ollamaRecordError(message, code, status) {
  const error = new Error(message);
  error.code = code;
  if (status !== undefined) error.status = status;
  return error;
}

function normalizeBufferedResponse(response, firstChunkMs) {
  const data = response?.data || {};
  return {
    response: typeof data.response === 'string' ? data.response : '',
    status: response?.status,
    done: data.done !== false,
    doneReason: data.done_reason,
    evalCount: data.eval_count,
    promptEvalCount: data.prompt_eval_count,
    loadDuration: data.load_duration,
    promptEvalDuration: data.prompt_eval_duration,
    evalDuration: data.eval_duration,
    totalDuration: data.total_duration,
    firstChunkMs,
  };
}

async function generateStructured({
  prompt, schema, format, model, baseUrl, options = {}, streaming = false,
  keepAlive, timeoutMs = 120000, signal, onFirstChunk,
}) {
  if (signal?.aborted) throw ollamaRecordError('Ollama request was cancelled.', 'ERR_CANCELED');

  const startedAt = performance.now();
  const controller = new AbortController();
  let timedOut = false;
  let callerCancelled = false;
  let firstChunkMs = null;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const abortFromCaller = () => {
    callerCancelled = true;
    controller.abort();
  };
  signal?.addEventListener('abort', abortFromCaller, { once: true });

  const notifyFirstChunk = () => {
    if (firstChunkMs !== null) return;
    firstChunkMs = Math.max(0, performance.now() - startedAt);
    onFirstChunk?.();
  };

  const body = { model, prompt, stream: streaming };
  const responseFormat = schema ?? format;
  if (responseFormat !== undefined) body.format = responseFormat;
  if (keepAlive !== undefined) body.keep_alive = keepAlive;
  if (options && Object.keys(options).length) body.options = options;
  const requestConfig = { timeout: timeoutMs, signal: controller.signal };
  if (streaming) requestConfig.responseType = 'stream';

  let response;
  try {
    response = await axios.post(`${(baseUrl || getBaseUrl()).replace(/\/+$/, '')}/api/generate`, body, requestConfig);
    if (!streaming || !response?.data || typeof response.data[Symbol.asyncIterator] !== 'function') {
      return normalizeBufferedResponse(response, firstChunkMs);
    }

    let buffer = '';
    let reply = '';
    let done = false;
    let doneReason;
    let evalCount;
    let promptEvalCount;
    let totalDuration;
    let loadDuration;
    let promptEvalDuration;
    let evalDuration;
    const decoder = new StringDecoder('utf8');
    const collectRecord = (record) => {
      if (typeof record.response === 'string') reply += record.response;
      if (record.done === true) {
        done = true;
        if (typeof record.done_reason === 'string') doneReason = record.done_reason;
        if (Number.isSafeInteger(record.eval_count)) evalCount = record.eval_count;
        if (Number.isSafeInteger(record.prompt_eval_count)) promptEvalCount = record.prompt_eval_count;
        for (const [key, value] of [
          ['total_duration', record.total_duration], ['load_duration', record.load_duration],
          ['prompt_eval_duration', record.prompt_eval_duration], ['eval_duration', record.eval_duration],
        ]) {
          if (!Number.isSafeInteger(value) || value < 0) continue;
          if (key === 'total_duration') totalDuration = value;
          else if (key === 'load_duration') loadDuration = value;
          else if (key === 'prompt_eval_duration') promptEvalDuration = value;
          else evalDuration = value;
        }
      }
    };

    for await (const chunk of response.data) {
      notifyFirstChunk();
      buffer += decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8'));
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        collectRecord(JSON.parse(line));
      }
      if (done) break;
    }
    buffer += decoder.end();
    if (buffer.trim()) collectRecord(JSON.parse(buffer));
    return {
      response: reply, status: response.status, done, doneReason, evalCount,
      promptEvalCount, totalDuration, loadDuration, promptEvalDuration,
      evalDuration, firstChunkMs,
    };
  } catch (error) {
    if (timedOut) throw ollamaRecordError('Ollama request timed out.', 'ECONNABORTED', response?.status);
    if (callerCancelled || signal?.aborted) throw ollamaRecordError('Ollama request was cancelled.', 'ERR_CANCELED', response?.status);
    if (error instanceof SyntaxError) {
      throw ollamaRecordError('Ollama returned an invalid stream record.', 'OLLAMA_INVALID_RESPONSE', response?.status);
    }
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abortFromCaller);
  }
}

module.exports = { generateStructured };
