'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');
const groq = require('../src/ai/providers/groqProvider');
const gateway = require('../src/ai/modelGateway');
const { getAIConfig, getAISource, isValidAISource } = require('../src/ai/config');

function env(t, changes) {
  const previous = Object.fromEntries(Object.keys(changes).map((name) => [name, process.env[name]]));
  for (const [name, value] of Object.entries(changes)) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
  t.after(() => { for (const [name, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  } });
}

const sample = { choices: [{ message: { content: '{"questions":["Q1?"]}' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 124, completion_tokens: 16, prompt_time: 0.05, completion_time: 0.1, total_time: 0.15 } };

const schema = { type: 'object', properties: { questions: { type: 'array', items: { type: 'string' } } }, required: ['questions'], additionalProperties: false };

test('Groq maps structured requests to official endpoint and back to gateway response contract', async (t) => {
  env(t, { AI_PROVIDER: 'groq', GROQ_API_KEY: 'fake-unit-test-key', GROQ_MODEL: 'openai/gpt-oss-120b', GROQ_REASONING_EFFORT: 'medium', GROQ_RESPONSE_FORMAT: 'json_schema' });
  let captured;
  t.mock.method(axios, 'post', async (url, body, options) => { captured = { url, body, options }; return { status: 200, data: sample }; });
  let first = 0;
  const response = await gateway.generateStructured({
    operation: 'category_generation', stage: 'generation', categoryId: 'technical_concepts',
    model: getAIConfig().model, prompt: 'Synthetic project data only', schema,
    streaming: true, options: { num_predict: 512, num_ctx: 4096, temperature: 0.2 }, keepAlive: '10m',
    timeoutMs: 1000, onFirstChunk: () => { first++; },
  });
  assert.equal(captured.url, 'https://api.groq.com/openai/v1/chat/completions');
  assert.equal(captured.body.model, 'openai/gpt-oss-120b');
  assert.equal(captured.body.messages[0].content, 'Synthetic project data only');
  assert.equal(captured.body.stream, false);
  assert.equal(captured.body.response_format.type, 'json_schema');
  assert.deepEqual(captured.body.response_format.json_schema.schema, schema);
  assert.equal(captured.body.response_format.json_schema.strict, false);
  assert.equal(captured.body.reasoning_effort, 'medium');
  assert.equal(captured.body.max_completion_tokens, 2048);
  assert.equal(captured.body.temperature, 0.2);
  assert.ok(!Object.hasOwn(captured.body, 'keep_alive'));
  assert.ok(!Object.hasOwn(captured.body, 'options'));
  assert.equal(captured.options.headers.Authorization, 'Bearer fake-unit-test-key');
  assert.equal(response.response, sample.choices[0].message.content);
  assert.equal(response.done, true);
  assert.equal(response.doneReason, 'stop');
  assert.equal(response.promptEvalCount, 124);
  assert.equal(response.evalCount, 16);
  assert.equal(response.promptEvalDuration, 50000000);
  assert.equal(response.evalDuration, 100000000);
  assert.equal(response.totalDuration, 150000000);
  assert.equal(response.provider, 'groq');
  assert.equal(first, 1);
});

test('Groq JSON object mode supports resume analysis without a schema', async (t) => {
  env(t, { GROQ_API_KEY: 'fake-unit-test-key', GROQ_RESPONSE_FORMAT: 'json_object', GROQ_MODEL: 'openai/gpt-oss-120b' });
  let captured;
  t.mock.method(axios, 'post', async (_url, body) => { captured = body; return { status: 200, data: sample }; });
  const result = await groq.generateStructured({ model: 'openai/gpt-oss-120b', prompt: 'Synthetic resume', format: 'json' });
  assert.deepEqual(captured.response_format, { type: 'json_object' });
  assert.equal(result.done, true);
});

test('No API key never makes a network call or exposes a secret', async (t) => {
  env(t, { GROQ_API_KEY: undefined });
  let count = 0;
  t.mock.method(axios, 'post', async () => { count++; });
  await assert.rejects(groq.generateStructured({ model: 'openai/gpt-oss-120b', prompt: 'x' }), { code: 'GROQ_API_KEY_MISSING' });
  assert.equal(count, 0);
});

test('Groq sanitizes free-tier rate-limit and auth errors (no upstream content)', async (t) => {
  env(t, { GROQ_API_KEY: 'fake-unit-test-key' });
  t.mock.method(axios, 'post', async () => {
    const error = new Error('PRIVATE PROMPT AND KEY from upstream');
    error.response = { status: 429, headers: { 'retry-after': '6' }, data: { error: 'PRIVATE' } };
    throw error;
  });
  const err = await groq.generateStructured({ model: 'openai/gpt-oss-120b', prompt: 'hidden prompt' }).catch((error) => error);
  assert.equal(err.code, 'GROQ_RATE_LIMITED');
  assert.equal(err.status, 429);
  assert.equal(err.retryAfterSeconds, 6);
  assert.doesNotMatch(err.message, /PRIVATE|hidden|fake-unit-test-key/);
});

test('Groq timeout and caller cancellation use the existing gateway error codes', async (t) => {
  env(t, { GROQ_API_KEY: 'fake-unit-test-key' });
  t.mock.method(axios, 'post', async (_url, _body, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { code: 'ERR_CANCELED' })), { once: true });
  }));
  await assert.rejects(groq.generateStructured({ model: 'openai/gpt-oss-120b', prompt: 'x', timeoutMs: 10 }), { code: 'ECONNABORTED' });
  const ctl = new AbortController();
  const p = groq.generateStructured({ model: 'openai/gpt-oss-120b', prompt: 'x', timeoutMs: 1000, signal: ctl.signal });
  await new Promise((r) => setImmediate(r));
  ctl.abort();
  await assert.rejects(p, { code: 'ERR_CANCELED' });
});

test('Groq rejects truncated and invalid outputs instead of claiming validated questions', async (t) => {
  env(t, { GROQ_API_KEY: 'fake-unit-test-key' });
  t.mock.method(axios, 'post', async () => ({ status: 200, data: { choices: [{ message: { content: '{}' }, finish_reason: 'length' }] } }));
  await assert.rejects(groq.generateStructured({ model: 'openai/gpt-oss-120b', prompt: 'x' }), { code: 'GROQ_OUTPUT_LIMIT' });
});

test('AI provenance accepts either configured provider and rejects fake or fallback labels', (t) => {
  env(t, { AI_PROVIDER: 'groq', GROQ_MODEL: 'openai/gpt-oss-120b' });
  assert.equal(getAISource(), 'groq-openai/gpt-oss-120b');
  assert.ok(isValidAISource('groq-openai/gpt-oss-120b', 'openai/gpt-oss-120b'));
  assert.ok(isValidAISource('ollama-llama3.2', 'llama3.2'));
  assert.equal(isValidAISource('heuristic-fallback', 'llama3.2'), false);
  assert.equal(isValidAISource('groq-openai/gpt-oss-20b', 'openai/gpt-oss-120b'), false);
  assert.equal(getAIConfig().model, 'openai/gpt-oss-120b');
});

test('Groq integration generates a six-question category with real application validation and provenance', async (t) => {
  env(t, { AI_PROVIDER: 'groq', GROQ_API_KEY: 'fake-unit-test-key', GROQ_MODEL: 'openai/gpt-oss-120b',
    GROQ_RESPONSE_FORMAT: 'json_schema', QUESTION_GENERATION_MODE: 'compact' });
  const generator = require('../src/services/questionGeneratorService');
  const { buildSyntheticContext } = require('../scripts/benchmarkAI');
  let requests = 0;
  t.mock.method(axios, 'post', async (url, body) => {
    requests++;
    assert.match(url, /api\.groq\.com/);
    assert.equal(body.model, 'openai/gpt-oss-120b');
    const examples = [
      ['event loop', 'How does the event loop manage callbacks while Node.js processes nonblocking requests?'],
      ['Express middleware', 'What happens when Express middleware calls next twice during one incoming HTTP request?'],
      ['MongoDB index', 'How would a MongoDB index change an explain plan for a filtered collection query?'],
      ['JavaScript closures', 'Why can JavaScript closures retain variables after the outer function has returned?'],
      ['HTTP caching', 'How does HTTP caching reduce repeated requests without returning stale application data?'],
      ['database transaction', 'When should a database transaction roll back an update across related records?'],
    ];
    return { status: 200, data: { choices: [{ message: { content: JSON.stringify({ items: examples.map(([topic, question]) => ({ topic, question })) }) }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 200, completion_tokens: 150 } } };
  });
  const result = await generator.generateCategoryQuestions(buildSyntheticContext(), 'technical_concepts', { force: true });
  assert.equal(result.status, 'ready');
  assert.equal(result.source, 'groq-openai/gpt-oss-120b');
  assert.equal(result.model, 'openai/gpt-oss-120b');
  assert.equal(result.questions.length, 6);
  assert.ok(requests >= 1);
});

test('Groq integration passes a validated evaluation with unchanged score rubric', async (t) => {
  env(t, { AI_PROVIDER: 'groq', GROQ_API_KEY: 'fake-unit-test-key', GROQ_MODEL: 'openai/gpt-oss-120b' });
  t.mock.method(axios, 'post', async () => ({ status: 200, data: {
    choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({
      relevance: 'good', score: 8.5, evidence: ['I would verify the status code'],
      feedback: 'Your response checks the relevant HTTP behavior and suggests a meaningful test.',
      strengths: ['You identified a testable HTTP outcome.'], improvements: ['Include one authorization failure case.'],
    }) } }], usage: { prompt_tokens: 1100, completion_tokens: 110 },
  } }));
  const service = require('../src/services/answerEvaluationService');
  const result = await service.evaluateAnswer({ question: 'How would you test an API?',
    answer: 'I would verify the status code and test invalid input.', categoryId: 'domain_fundamentals',
    categoryLabel: 'Role & Domain Fundamentals', resumeContext: { targetRole: 'Backend Developer', skills: ['Node.js'] } });
  assert.equal(result.score, 8.5);
  assert.equal(result.relevance, 'good');
  assert.equal(result.model, 'openai/gpt-oss-120b');
});
