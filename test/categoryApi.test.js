'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Resume = require('../src/models/Resume');
const generator = require('../src/services/questionGeneratorService');
const controller = require('../src/controllers/resumeController');

const userId = '000000000000000000000001';
const otherUser = '000000000000000000000002';
const resumeId = '100000000000000000000001';
const record = { resumeContext: { targetRole: 'Backend Developer', skills: ['Node.js'] } };
function res() {
  return { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
}
function req(owner = userId, category = 'domain_fundamentals', id = resumeId, body) {
  return { user: { id: owner }, params: { id, category }, body };
}

test('category API rejects invalid categories and request data before generation', async (t) => {
  t.mock.method(Resume, 'findOne', () => { throw new Error('Invalid request must not query'); });
  const generate = t.mock.method(generator, 'generateCategoryQuestions', async () => { throw new Error('Must not generate'); });
  for (const [request, expected] of [[req(userId, 'invalid'), 400], [req(userId, 'domain_fundamentals', resumeId, { count: 2 }), 400]]) {
    const response = res();
    await controller.generateCategoryQuestions(request, response);
    assert.equal(response.statusCode, expected);
  }
  assert.equal(generate.mock.callCount(), 0);
});

test('category API verifies resume ownership and uses saved context', async (t) => {
  t.mock.method(Resume, 'findOne', (filter) => ({ lean: async () => filter.userId === userId ? record : null }));
  const generate = t.mock.method(generator, 'generateCategoryQuestions', async (context, category) => {
    assert.strictEqual(context, record.resumeContext);
    assert.equal(category, 'applied_scenarios');
    const model = 'llama3.2';
    return { category, model, questions: Array.from({ length: 6 }, (_, index) => ({
      question: `Suppose a Node.js integration fails in case ${index}; how would you isolate and verify recovery?`,
      type: 'technical', basedOn: 'Node.js', categoryId: category, slotId: `slot_${index + 1}`,
    })), source: `ollama-${model}`, status: 'ready', metrics: {} };
  });
  const foreign = res();
  await controller.generateCategoryQuestions(req(otherUser, 'applied_scenarios'), foreign);
  assert.equal(foreign.statusCode, 404);
  assert.equal(generate.mock.callCount(), 0);
  const response = res();
  await controller.generateCategoryQuestions(req(userId, 'applied_scenarios'), response);
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.source, 'ollama-llama3.2');
  assert.equal(response.body.category, 'applied_scenarios');
  assert.equal(generate.mock.callCount(), 1);
});

test('category API never presents rule-based output as a successful generated set', async (t) => {
  t.mock.method(Resume, 'findOne', () => ({ lean: async () => record }));
  t.mock.method(generator, 'generateCategoryQuestions', async () => ({ status: 'ready', source: 'heuristic-fallback',
    category: 'domain_fundamentals', questions: Array.from({ length: 6 }, () => ({ question: 'sample' })) }));
  const response = res();
  await controller.generateCategoryQuestions(req(), response);
  assert.equal(response.statusCode, 502);
  assert.equal(response.body.errorCode, 'invalid-generation');
});

test('category API exposes insufficient evidence and sanitizes generation failures', async (t) => {
  t.mock.method(Resume, 'findOne', () => ({ lean: async () => record }));
  const generate = t.mock.method(generator, 'generateCategoryQuestions', async () => {
    throw Object.assign(new Error('private resume text must not escape'), { code: 'INSUFFICIENT_RESUME_EVIDENCE' });
  });
  const insufficient = res();
  await controller.generateCategoryQuestions(req(), insufficient);
  assert.equal(insufficient.statusCode, 422);
  assert.equal(insufficient.body.errorCode, 'insufficient-evidence');
  assert.doesNotMatch(JSON.stringify(insufficient.body), /private resume text/);

  generate.mock.mockImplementation(async () => { throw Object.assign(new Error('private resume text must not escape'), { code: 'LOCAL_ERROR' }); });
  const failure = res();
  await controller.generateCategoryQuestions(req(), failure);
  assert.equal(failure.statusCode, 503);
  assert.equal(failure.body.errorCode, 'generation-failed');
  assert.doesNotMatch(JSON.stringify(failure.body), /private resume text/);
});

test('category API rejects overlapping generation for the same resume and category', async (t) => {
  t.mock.method(Resume, 'findOne', () => ({ lean: async () => record }));
  let finish;
  const generate = t.mock.method(generator, 'generateCategoryQuestions', () => new Promise((resolve) => { finish = resolve; }));
  const firstResponse = res();
  const first = controller.generateCategoryQuestions(req(), firstResponse);
  await new Promise((resolve) => setImmediate(resolve));
  const secondResponse = res();
  await controller.generateCategoryQuestions(req(), secondResponse);
  assert.equal(secondResponse.statusCode, 409);
  assert.equal(generate.mock.callCount(), 1);
  const model = 'llama3.2';
  finish({ category: 'domain_fundamentals', model, source: `ollama-${model}`, status: 'ready',
    questions: Array.from({ length: 6 }, (_, index) => ({ question: `How would you inspect a request path at stage ${index}?` })) });
  await first;
  assert.equal(firstResponse.statusCode, 200);
});
