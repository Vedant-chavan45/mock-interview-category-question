'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const axios = require('axios');
const provider = require('../src/ai/providers/ollamaProvider');
const gateway = require('../src/ai/modelGateway');
const telemetry = require('../src/ai/telemetry');
const { QUESTION_CATEGORIES } = require('../src/services/questionCategories');

function setEnv(t, key, value) {
  const previous = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  t.after(() => {
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  });
}

test('Ollama provider preserves structured streaming options, chunks split at UTF-8 and record boundaries, and metadata', async (t) => {
  let request;
  const records = [
    `${JSON.stringify({ response: '{"note":"café"}', done: false })}\n`,
    `${JSON.stringify({ response: '', done: true, done_reason: 'stop', eval_count: 8, prompt_eval_count: 21,
      load_duration: 1000000, prompt_eval_duration: 2000000, eval_duration: 3000000, total_duration: 7000000 })}\n`,
  ].join('');
  const bytes = Buffer.from(records);
  const splitAt = bytes.indexOf(Buffer.from('é')) + 1;
  t.mock.method(axios, 'post', async (url, body, config) => {
    request = { url, body, config };
    return { status: 200, data: Readable.from([bytes.subarray(0, splitAt), bytes.subarray(splitAt)]) };
  });
  let firstChunkCalls = 0;
  const schema = { type: 'object', properties: { note: { type: 'string' } } };
  const result = await provider.generateStructured({
    model: 'llama3.2:latest', prompt: 'synthetic prompt', schema, streaming: true,
    keepAlive: '10m', options: { num_predict: 64, num_ctx: 2048, temperature: 0.2 },
    timeoutMs: 500, onFirstChunk: () => { firstChunkCalls += 1; },
  });
  assert.equal(request.url, `${(process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434').replace(/\/+$/, '')}/api/generate`);
  assert.equal(request.body.model, 'llama3.2:latest');
  assert.equal(request.body.prompt, 'synthetic prompt');
  assert.deepEqual(request.body.format, schema);
  assert.equal(request.body.stream, true);
  assert.equal(request.body.keep_alive, '10m');
  assert.deepEqual(request.body.options, { num_predict: 64, num_ctx: 2048, temperature: 0.2 });
  assert.equal(request.config.responseType, 'stream');
  assert.equal(request.config.timeout, 500);
  assert.equal(result.response, '{"note":"café"}');
  assert.equal(result.doneReason, 'stop');
  assert.equal(result.evalCount, 8);
  assert.equal(result.promptEvalCount, 21);
  assert.equal(result.loadDuration, 1000000);
  assert.equal(result.promptEvalDuration, 2000000);
  assert.equal(result.evalDuration, 3000000);
  assert.equal(result.totalDuration, 7000000);
  assert.equal(firstChunkCalls, 1);
  assert.ok(result.firstChunkMs >= 0);
});

test('Ollama provider uses buffered structured mode and passes schema, model options, and available metadata', async (t) => {
  let request;
  t.mock.method(axios, 'post', async (url, body, config) => {
    request = { url, body, config };
    return { status: 200, data: { response: '{"ok":true}', done: true, eval_count: 4, prompt_eval_count: 13 } };
  });
  const response = await provider.generateStructured({
    model: 'llama3.2:latest', baseUrl: 'http://ollama.example:11434/',
    prompt: 'synthetic prompt', format: 'json', streaming: false,
    keepAlive: '10m', options: { temperature: 0, num_predict: 800, num_ctx: 4096 }, timeoutMs: 900,
  });
  assert.equal(request.body.stream, false);
  assert.equal(request.url, 'http://ollama.example:11434/api/generate');
  assert.equal(request.body.format, 'json');
  assert.equal(request.body.keep_alive, '10m');
  assert.deepEqual(request.body.options, { temperature: 0, num_predict: 800, num_ctx: 4096 });
  assert.equal(request.config.responseType, undefined);
  assert.equal(response.response, '{"ok":true}');
  assert.equal(response.evalCount, 4);
  assert.equal(response.promptEvalCount, 13);
  assert.equal(response.loadDuration, undefined);
  assert.equal(response.firstChunkMs, null);
});

test('Ollama provider converts its timeout into the legacy timeout code', async (t) => {
  t.mock.method(axios, 'post', async (_url, _body, config) => new Promise((_resolve, reject) => {
    config.signal.addEventListener('abort', () => reject(Object.assign(new Error('timeout'), { code: 'ERR_CANCELED' })), { once: true });
  }));
  await assert.rejects(provider.generateStructured({
    model: 'llama3.2', prompt: 'synthetic', streaming: false, timeoutMs: 10,
  }), { code: 'ECONNABORTED' });
});

test('Ollama provider aborts on caller cancellation', async (t) => {
  t.mock.method(axios, 'post', async (_url, _body, config) => new Promise((_resolve, reject) => {
    config.signal.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { code: 'ERR_CANCELED' })), { once: true });
  }));
  const controller = new AbortController();
  const pending = provider.generateStructured({
    model: 'llama3.2', prompt: 'synthetic', streaming: false, timeoutMs: 1000, signal: controller.signal,
  });
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  await assert.rejects(pending, { code: 'ERR_CANCELED' });
});

test('gateway rejects unsupported providers without calling Ollama or disguising a fallback', async (t) => {
  setEnv(t, 'AI_PROVIDER', 'unsupported-provider');
  setEnv(t, 'AI_PERF_LOG_ENABLED', '1');
  let postCalls = 0;
  const events = [];
  t.mock.method(axios, 'post', async () => { postCalls += 1; });
  t.mock.method(console, 'log', (line) => events.push(line));
  await assert.rejects(gateway.generateStructured({
    operation: 'category_generation', categoryId: 'domain_fundamentals', stage: 'generation',
    model: 'llama3.2', prompt: 'private prompt', streaming: true,
  }), { code: 'AI_PROVIDER_UNSUPPORTED' });
  assert.equal(postCalls, 0);
  assert.equal(events.length, 1);
  const event = JSON.parse(events[0]);
  assert.equal(event.failureCategory, 'unsupported_provider');
  assert.equal(event.provider, 'unsupported');
  assert.doesNotMatch(events[0], /private prompt|unsupported-provider/);
});

test('telemetry converts Ollama nanoseconds to milliseconds and omits absent metrics and private text', (t) => {
  setEnv(t, 'AI_PERF_LOG_ENABLED', '1');
  const events = [];
  t.mock.method(console, 'log', (line) => events.push(line));
  telemetry.recordInference({
    operation: 'answer_evaluation', provider: 'ollama', model: 'llama3.2:latest',
    categoryId: 'technical_concepts', stage: 'evaluation', outcome: 'success',
    elapsedMs: 22.5, loadDuration: 123456789, promptEvalDuration: 2000000,
    evalDuration: 3456789, totalDuration: 14000000, promptEvalCount: 10, evalCount: 5,
    retryCount: 1, error: new Error('candidate@example.test private answer text'),
    prompt: 'private prompt text', answer: 'private answer text',
  });
  telemetry.recordInference({ operation: 'resume_analysis', provider: 'ollama', model: 'llama3.2', stage: 'resume_analysis' });
  const first = JSON.parse(events[0]);
  assert.equal(first.event, 'ai.inference');
  assert.equal(first.loadMs, 123.457);
  assert.equal(first.promptProcessingMs, 2);
  assert.equal(first.decodeMs, 3.457);
  assert.equal(first.modelTotalMs, 14);
  assert.equal(first.promptTokens, 10);
  assert.equal(first.generatedTokens, 5);
  assert.equal(first.retryCount, 1);
  assert.equal(typeof first.requestId, 'string');
  const second = JSON.parse(events[1]);
  assert.equal(second.loadMs, null);
  assert.equal(second.promptTokens, null);
  assert.equal(second.timeToFirstChunkMs, null);
  assert.doesNotMatch(events.join('\n'), /candidate@example\.test|private prompt text|private answer text/);
});

test('category registry still contains all six public category IDs', () => {
  assert.deepEqual(Object.keys(QUESTION_CATEGORIES), [
    'domain_fundamentals', 'technical_concepts', 'project_deep_dive',
    'professional_experience', 'applied_scenarios', 'behavioral_collaboration',
  ]);
});
