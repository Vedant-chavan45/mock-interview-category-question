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

test('category API verifies resume ownership, uses saved context and persists the generated set', async (t) => {
  t.mock.method(Resume, 'findOne', (filter) => ({ lean: async () => filter.userId === userId ? record : null }));
  const update = t.mock.method(Resume, 'updateOne', async (filter, change) => {
    assert.equal(filter._id, resumeId);
    assert.equal(filter.userId, userId);
    const saved = change.$set['practice.categories.applied_scenarios'];
    assert.equal(saved.questions.length, 6);
    assert.equal(saved.questions[0].answer, '');
    assert.equal(saved.questions[0].evaluation, null);
    return { matchedCount: 1 };
  });
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
  assert.equal(update.mock.callCount(), 1);
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
  const update = t.mock.method(Resume, 'updateOne', async () => ({ matchedCount: 1 }));
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
  assert.equal(update.mock.callCount(), 0, 'failed generation must not replace the last saved set');
});

test('technical regeneration persists bounded coverage and preserves the prior answered set in history', async (t) => {
  const previous = {
    question: 'How do Python generators resume after yield?',
    answer: 'They continue from the suspended frame.',
    evaluation: { score: 8, feedback: 'Clear explanation.' },
    primaryRequiredSkill: 'Python', subtopic: 'generator iteration and yield',
    assessmentObjective: 'trace iterator state after yield', coverageSignature: 'python|generator|state',
  };
  const savedRecord = {
    resumeContext: { ...record.resumeContext, requiredSkillset: ['Python', 'Pandas'] },
    practice: { categories: { technical_concepts: {
      status: 'ready', questions: [previous], skillsCovered: ['Python'], generationNumber: 1,
      coverage: [{ primaryRequiredSkill: 'Python', subtopic: previous.subtopic, coverageSignature: previous.coverageSignature }],
    } } },
  };
  t.mock.method(Resume, 'findOne', () => ({ lean: async () => savedRecord }));
  t.mock.method(generator, 'generateCategoryQuestions', async (_context, category, options) => {
    assert.equal(category, 'technical_concepts');
    assert.equal(options.force, true);
    assert.equal(options.history[0].questions[0].answer, previous.answer);
    assert.equal(options.history[0].questions[0].evaluation.score, 8);
    const model = 'llama3.2';
    return {
      category, model, source: `ollama-${model}`, status: 'ready', metrics: {},
      questions: Array.from({ length: 6 }, (_, index) => {
        const primaryRequiredSkill = index % 2 ? 'Pandas' : 'Python';
        return {
          question: `How does ${primaryRequiredSkill} handle assessment case ${index}?`,
          primaryRequiredSkill, primaryAssessmentTarget: primaryRequiredSkill,
          subtopic: `${primaryRequiredSkill} subtopic ${index}`, assessmentObjective: `objective ${index}`,
          coverageSignature: `${primaryRequiredSkill.toLowerCase()}|subtopic-${index}`,
          evidenceIds: [], evidenceProvenance: { kind: 'required_skill_assessment' },
        };
      }),
    };
  });
  const update = t.mock.method(Resume, 'updateOne', async (filter, change) => {
    assert.equal(filter._id, resumeId);
    assert.equal(filter.userId, userId);
    const saved = change.$set['practice.categories.technical_concepts'];
    assert.equal(saved.generationNumber, 2);
    assert.equal(saved.history.length, 1);
    assert.equal(saved.history[0].questions[0].answer, previous.answer);
    assert.deepEqual(saved.history[0].questions[0].evaluation, previous.evaluation);
    assert.equal(saved.questions.length, 6);
    assert.equal(saved.questions[0].answer, '');
    assert.ok(saved.coverageLedger.find((entry) => entry.skill === 'Python').assessmentCount >= 1);
    assert.ok(saved.coverageLedger.find((entry) => entry.skill === 'Pandas').assessmentCount >= 1);
    return { matchedCount: 1 };
  });
  const response = res();
  await controller.generateCategoryQuestions(req(userId, 'technical_concepts'), response);
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.generationNumber, 2);
  assert.equal(update.mock.callCount(), 1);
});

test('category API rejects overlapping generation for the same resume and category', async (t) => {
  t.mock.method(Resume, 'findOne', () => ({ lean: async () => record }));
  t.mock.method(Resume, 'updateOne', async () => ({ matchedCount: 1 }));
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


test('practice API returns only the authenticated owner\'s saved category data', async (t) => {
  const practice = { categories: { domain_fundamentals: { status: 'ready', questions: [{ question: 'How do you test an API?', answer: 'I test status codes.', evaluation: { score: 8.5 } }] } } };
  t.mock.method(Resume, 'findOne', (filter) => ({ lean: async () => filter.userId === userId ? { ...record, practice } : null }));
  const response = res();
  await controller.getPractice(req(), response);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body.categories, practice.categories);
  const foreign = res();
  await controller.getPractice(req(otherUser), foreign);
  assert.equal(foreign.statusCode, 404);
});

test('answer evaluation validates input before accessing resume data', async (t) => {
  t.mock.method(Resume, 'findOne', () => { throw new Error('Invalid request must not query'); });
  const evaluate = t.mock.method(require('../src/services/answerEvaluationService'), 'evaluateAnswer', async () => {
    throw new Error('Must not evaluate');
  });
  for (const [request, expected] of [
    [{ ...req(userId, 'not_a_category'), params: { ...req().params, category: 'not_a_category', questionIndex: '0' }, body: { answer: 'A sufficiently long answer.' } }, 400],
    [{ ...req(), params: { ...req().params, questionIndex: '6' }, body: { answer: 'A sufficiently long answer.' } }, 400],
    [{ ...req(), params: { ...req().params, questionIndex: '0' }, body: { answer: '   ' } }, 400],
    [{ ...req(), params: { ...req().params, questionIndex: '0' }, body: { answer: 'Answer', other: 'not allowed' } }, 400],
  ]) {
    const response = res();
    await controller.evaluateAnswer(request, response);
    assert.equal(response.statusCode, expected);
  }
  assert.equal(evaluate.mock.callCount(), 0);
});

test('answer evaluation checks ownership, evaluates and persists answer plus score and feedback', async (t) => {
  const questionSet = { status: 'ready', questions: Array.from({ length: 6 }, (_, index) => ({
    question: `How would you test API behavior ${index}?`, slotId: `slot_${index}`, type: 'technical', basedOn: 'Node.js',
  })) };
  t.mock.method(Resume, 'findOne', (filter) => ({ lean: async () => filter.userId === userId ? {
    ...record, practice: { categories: { domain_fundamentals: questionSet } },
  } : null }));
  const evaluate = t.mock.method(require('../src/services/answerEvaluationService'), 'evaluateAnswer', async (input) => {
    assert.equal(input.question, 'How would you test API behavior 2?');
    assert.equal(input.answer, 'I would test valid and invalid requests.');
    assert.equal(input.categoryLabel, 'Role & Domain Fundamentals');
    return { relevance: 'good', score: 8.5, evidence: ['I would test valid and invalid requests.'], feedback: 'A relevant and well-structured answer with sound testing steps.',
      strengths: ['You covered valid and invalid cases.'], improvements: ['Mention boundary and authorization tests.'], model: 'llama3.2:latest' };
  });
  const update = t.mock.method(Resume, 'updateOne', async (filter, change) => {
    assert.equal(filter['practice.categories.domain_fundamentals.questions.2.question'], 'How would you test API behavior 2?');
    const saved = change.$set;
    assert.equal(saved['practice.categories.domain_fundamentals.questions.2.answer'], 'I would test valid and invalid requests.');
    assert.equal(saved['practice.categories.domain_fundamentals.questions.2.evaluation'].score, 8.5);
    assert.equal(saved['practice.categories.domain_fundamentals.questions.2.evaluation'].relevance, 'good');
    assert.deepEqual(saved['practice.categories.domain_fundamentals.questions.2.evaluation'].evidence, ['I would test valid and invalid requests.']);
    assert.match(saved['practice.categories.domain_fundamentals.questions.2.evaluation'].feedback, /well-structured/);
    return { matchedCount: 1 };
  });
  const foreign = res();
  await controller.evaluateAnswer({ ...req(otherUser), params: { ...req().params, questionIndex: '2' }, body: { answer: 'I would test valid and invalid requests.' } }, foreign);
  assert.equal(foreign.statusCode, 404);
  const response = res();
  await controller.evaluateAnswer({ ...req(), params: { ...req().params, questionIndex: '2' }, body: { answer: 'I would test valid and invalid requests.' } }, response);
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.evaluation.score, 8.5);
  assert.equal(response.body.questionIndex, 2);
  assert.equal(evaluate.mock.callCount(), 1);
  assert.equal(update.mock.callCount(), 1);
});



test('answer evaluation rejects a second in-flight request for the same question', async (t) => {
  const questionSet = { status: 'ready', questions: Array.from({ length: 6 }, (_, index) => ({
    question: `How would you test a request at stage ${index}?`, slotId: `slot_${index}`,
  })) };
  t.mock.method(Resume, 'findOne', () => ({ lean: async () => ({
    ...record, practice: { categories: { domain_fundamentals: questionSet } },
  }) }));
  t.mock.method(Resume, 'updateOne', async () => ({ matchedCount: 1 }));
  let finishEvaluation;
  const evaluate = t.mock.method(require('../src/services/answerEvaluationService'), 'evaluateAnswer', () =>
    new Promise((resolve) => { finishEvaluation = resolve; }));
  const request = { ...req(), params: { ...req().params, questionIndex: '0' },
    body: { answer: 'I would check the request, response and error handling.' } };

  const firstResponse = res();
  const firstRequest = controller.evaluateAnswer(request, firstResponse);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(evaluate.mock.callCount(), 1);

  const secondResponse = res();
  await controller.evaluateAnswer(request, secondResponse);
  assert.equal(secondResponse.statusCode, 409);
  assert.match(secondResponse.body.error, /already being evaluated/i);
  assert.equal(evaluate.mock.callCount(), 1, 'a duplicate request must not call Ollama again');

  finishEvaluation({ relevance: 'good', score: 8, evidence: ['check the request, response'],
    feedback: 'A relevant response.', strengths: ['You covered the request and response.'],
    improvements: ['Add a concrete test case.'], model: 'llama3.2:latest' });
  await firstRequest;
  assert.equal(firstResponse.statusCode, 200);
});

test('answer text is preserved when Ollama evaluation fails so the candidate can retry', async (t) => {
  const questionSet = { status: 'ready', questions: Array.from({ length: 6 }, (_, index) => ({
    question: `Explain API test case ${index}?`, slotId: `slot_${index}`,
  })) };
  t.mock.method(Resume, 'findOne', () => ({ lean: async () => ({
    ...record, practice: { categories: { domain_fundamentals: questionSet } },
  }) }));
  t.mock.method(require('../src/services/answerEvaluationService'), 'evaluateAnswer', async () => {
    throw Object.assign(new Error('Ollama unavailable'), { code: 'ECONNREFUSED' });
  });
  const update = t.mock.method(Resume, 'updateOne', async (filter, change) => {
    assert.equal(filter['practice.categories.domain_fundamentals.questions.0.question'], 'Explain API test case 0?');
    assert.equal(change.$set['practice.categories.domain_fundamentals.questions.0.answer'], 'I would test both success and error responses.');
    assert.deepEqual(Object.keys(change.$set), ['practice.categories.domain_fundamentals.questions.0.answer']);
    return { matchedCount: 1 };
  });
  const response = res();
  await controller.evaluateAnswer({ ...req(), params: { ...req().params, questionIndex: '0' },
    body: { answer: 'I would test both success and error responses.' } }, response);
  assert.equal(response.statusCode, 503);
  assert.equal(response.body.errorCode, 'evaluation-unavailable');
  assert.equal(update.mock.callCount(), 1);
});
