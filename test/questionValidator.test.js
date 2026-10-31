const test = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');
const { validateGeneratedQuestions: validate } = require('../src/services/questionValidatorService');
const { buildInterviewPlan } = require('../src/services/interviewPlannerService');
const { generateQuestions, heuristicFallbackQuestions } = require('../src/services/questionGeneratorService');

const context = {
  targetRole: 'Backend Developer', skills: ['Node.js', 'MongoDB', 'C++'],
  projects: [{ title: 'Nexus', technologies: ['MongoDB'], description: 'Built REST APIs.' }],
  experience: [{ role: 'Backend Intern', organisation: 'Example Co',
    responsibilities: ['Designed REST APIs'] }],
  education: [{ degree: 'B.Tech', institution: 'Example University', year: '2025' }],
};
const plan = buildInterviewPlan(context);
function fixture(types = ['technical', 'technical', 'project', 'project', 'experience', 'behavioral']) {
  return { questions: types.map((type, i) => ({ question: `How would you approach design scenario ${i + 1}?`,
    type, basedOn: type === 'behavioral' ? 'general' : type === 'experience' ? 'Backend Intern: Designed REST APIs'
      : type === 'project' ? 'Nexus - MongoDB' : 'MongoDB' })) };
}
function rejectChange(change) {
  const result = fixture(); change(result);
  assert.throws(() => validate(result, context, plan), /Invalid generated questions/);
}

test('rejections expose stable internal reason/count/index metadata without changing the error message', () => {
  const cases = [
    ['invalid-envelope', (r) => { r.extra = true; }, undefined],
    ['wrong-question-count', (r) => { r.questions.pop(); }, undefined],
    ['invalid-item-shape', (r) => { r.questions[2].extra = true; }, 2],
    ['invalid-type', (r) => { r.questions[2].type = 'coding'; }, 2],
    ['empty-or-oversized-field', (r) => { r.questions[2].question = ' '; }, 2],
    ['duplicate-question', (r) => { r.questions[2].question = r.questions[0].question; }, 2],
    ['generic-definition', (r) => { r.questions[2].question = 'What is MongoDB?'; }, 2],
    ['invalid-grounding', (r) => { r.questions[2].basedOn = 'Kubernetes'; }, 2],
    ['invalid-distribution', (r) => { r.questions[2].type = 'technical'; }, undefined],
  ];
  for (const [code, change, index] of cases) {
    const result = fixture(); change(result);
    assert.throws(() => validate(result, context, plan), (error) => {
      assert.equal(error.message, 'Invalid generated questions.');
      assert.equal(error.code, code);
      assert.equal(error.questionIndex, index);
      assert.equal(error.questionCount, result.questions.length);
      const expectedKeys = index === undefined ? ['code', 'questionCount'] : ['code', 'questionCount', 'questionIndex'];
      if (code === 'invalid-distribution') expectedKeys.push('actualTypeCounts', 'expectedTypeCounts');
      assert.deepEqual(Object.keys(error).sort(), expectedKeys.sort());
      return true;
    });
  }
  assert.throws(() => validate(null, context, plan), (error) =>
    error.code === 'invalid-envelope' && error.questionCount === undefined);
});

test('accepts exactly six grounded questions and normalizes strings without mutating input', () => {
  const result = fixture();
  result.questions[0] = { question: '  How did you use MongoDB in Nexus and what trade-offs did you consider?  ',
    type: ' technical ', basedOn: '  Nexus - MongoDB  ' };
  const before = structuredClone(result);
  const questions = validate(result, context, plan);
  assert.equal(questions.length, 6);
  assert.equal(questions[0].question, result.questions[0].question.trim());
  assert.equal(questions[0].basedOn, 'Nexus - MongoDB');
  assert.equal(questions[0].type, 'technical');
  assert.deepEqual(result, before);
});

test('rejects counts other than six, malformed envelopes and extra root fields', () => {
  for (const count of [0, 1, 5, 7, 8]) rejectChange((r) => {
    r.questions = Array.from({ length: count }, (_, i) => fixture().questions[i % 6]);
  });
  for (const result of [null, [], {}, { questions: 'invalid' }, { ...fixture(), source: 'model' }]) {
    assert.throws(() => validate(result, context, plan));
  }
});

test('rejects invalid item shape, missing/extra fields, invalid types, blanks and non-strings', () => {
  for (const value of [null, [], 'question', new Date()]) rejectChange((r) => { r.questions[0] = value; });
  const inherited = Object.create(fixture().questions[0]);
  rejectChange((r) => { r.questions[0] = inherited; });
  for (const field of ['question', 'type', 'basedOn']) {
    rejectChange((r) => { delete r.questions[0][field]; });
    for (const value of ['', '   ', null, 42, {}]) rejectChange((r) => { r.questions[0][field] = value; });
  }
  rejectChange((r) => { r.questions[0].type = 'coding'; });
  rejectChange((r) => { r.questions[0].difficulty = 'easy'; });
});

test('rejects duplicate text across case, repeated whitespace and trailing punctuation', () => {
  for (const duplicate of ['HOW WOULD YOU APPROACH DESIGN SCENARIO 1?',
    '  How   would you approach design scenario 1?  ', 'How would you approach design scenario 1!!!']) {
    rejectChange((r) => { r.questions[1].question = duplicate; });
  }
});

test('rejects standalone definitions while allowing applied questions', () => {
  for (const question of ['What is MongoDB?', 'What are REST APIs?', 'Define REST API.', 'Define polymorphism.']) {
    rejectChange((r) => { r.questions[0].question = question; });
  }
  for (const question of ['How did you use MongoDB in Nexus and what trade-offs did you consider?',
    'Explain how you designed authentication in your project.', 'What is your approach to debugging MongoDB?']) {
    const result = fixture(); result.questions[0].question = question;
    assert.equal(validate(result, context, plan)[0].question, question);
  }
});

test('enforces normal and sparse distributions, including legacy experience', () => {
  const variants = [
    [context, ['technical', 'technical', 'project', 'project', 'experience', 'behavioral']],
    [{ ...context, experience: [] }, ['technical', 'technical', 'project', 'project', 'technical', 'behavioral']],
    [{ ...context, experience: [] }, ['technical', 'technical', 'project', 'project', 'project', 'behavioral']],
    [{ ...context, projects: [] }, ['technical', 'technical', 'technical', 'technical', 'experience', 'behavioral']],
    [{ skills: ['MongoDB'] }, ['technical', 'technical', 'technical', 'technical', 'technical', 'behavioral']],
    [{ skills: ['MongoDB'], experienceSummary: 'Backend Intern: Designed REST APIs' },
      ['technical', 'technical', 'technical', 'technical', 'experience', 'behavioral']],
  ];
  for (const [c, types] of variants) assert.equal(validate(fixture(types), c, buildInterviewPlan(c)).length, 6);
  for (const types of [
    ['technical', 'project', 'project', 'project', 'experience', 'behavioral'],
    ['technical', 'technical', 'technical', 'project', 'experience', 'behavioral'],
    ['technical', 'technical', 'project', 'project', 'technical', 'behavioral'],
    ['technical', 'technical', 'project', 'project', 'experience', 'technical'],
  ]) assert.throws(() => validate(fixture(types), context, plan));
  assert.throws(() => validate(fixture(), { skills: ['MongoDB'] }, plan));
});

test('grounding accepts combined anchors and whole tokens but rejects fabrication and analysis-only claims', () => {
  for (const basedOn of ['NEXUS - mongodb', 'Backend Intern: Designed REST APIs', 'Example Co',
    'Example University', 'B.Tech', '2025', 'REST APIs', 'Node.js', 'C++', 'REST API Design', 'Backend Developer']) {
    const result = fixture(); result.questions[0].basedOn = basedOn;
    assert.equal(validate(result, context, plan).length, 6, basedOn);
  }
  for (const basedOn of ['Kubernetes production cluster', 'Nexus - Kubernetes', 'Mongo', 'general', 'API ninja']) {
    rejectChange((r) => { r.questions[0].basedOn = basedOn; });
  }
  const result = fixture(); result.questions[0].basedOn = 'Kubernetes';
  assert.throws(() => validate(result, { ...context, candidateSummary: 'Kubernetes', strengths: ['Kubernetes'] }, plan));
  result.questions[5].basedOn = 'fabricated team';
  assert.throws(() => validate(result, context, plan));
});

test('applies compact output upper bounds to question and basedOn strings', () => {
  rejectChange((r) => { r.questions[0].question = 'x'.repeat(241); });
  rejectChange((r) => { r.questions[0].basedOn = 'MongoDB '.repeat(18); });
  const result = fixture(); result.questions[0].question = 'x'.repeat(240);
  result.questions[0].basedOn = 'MongoDB';
  assert.equal(validate(result, context, plan)[0].question.length, 240);
});

test('missing/malformed context and plan are safe and empty evidence never enables project/experience slots', () => {
  const types = ['technical', 'technical', 'technical', 'technical', 'technical', 'behavioral'];
  const result = fixture(types);
  result.questions.forEach((q) => { if (q.type !== 'behavioral') q.basedOn = 'Software Design'; });
  for (const c of [undefined, null, 42, {}, { projects: [null, {}], experience: [null, {}],
    skills: {}, education: 'bad', targetRole: {}, experienceSummary: [] }]) {
    assert.equal(validate(result, c, { focusAreas: [{ topic: 'Software Design', evidence: null }] }).length, 6);
    assert.throws(() => validate(result, c, null), /Invalid generated questions/);
  }
});

test('generation accepts six question strings and assigns grounded metadata locally', async (t) => {
  const post = t.mock.method(axios, 'post');
  const modelQuestions = fixture().questions.map(({ question }) => question);
  post.mock.mockImplementation(async () => ({ data: { response: JSON.stringify({ questions: modelQuestions }) } }));
  const result = await generateQuestions(context);
  assert.equal(result.source, 'ollama-llama3.2');
  assert.equal(result.questions.length, 6);
  assert.deepEqual(result.questions.map((q) => q.type), ['technical', 'technical', 'project', 'project', 'experience', 'behavioral']);
  assert.ok(result.questions.every((q) => q.basedOn && q.basedOn.length <= 80));

  const bad = [];
  bad.push({ questions: modelQuestions.slice(0, 5) });
  bad.push({ questions: [modelQuestions[0], modelQuestions[0], ...modelQuestions.slice(2)] });
  bad.push({ questions: modelQuestions.map((question, index) => index === 0 ? { question, type: 'coding' } : question) });
  bad.push({ questions: modelQuestions.map((question, index) => index === 0 ? { question, basedOn: 'Kubernetes production cluster' } : question) });
  for (const payload of bad) {
    const calls = post.mock.callCount();
    post.mock.mockImplementation(async () => ({ data: { response: JSON.stringify(payload) } }));
    assert.deepEqual(await generateQuestions(context), heuristicFallbackQuestions(context));
    assert.equal(post.mock.callCount(), calls + 1);
  }
});

test('JSON parsing failures get one retry; parsed semantic failures do not retry', async (t) => {
  const post = t.mock.method(axios, 'post', async () => ({ data: { response: 'not json' } }));
  assert.deepEqual(await generateQuestions(context), heuristicFallbackQuestions(context));
  assert.equal(post.mock.callCount(), 2);
  const validModelOutput = { questions: fixture().questions.map(({ question }) => question) };
  post.mock.mockImplementation(async () => ({ data: { response: JSON.stringify(validModelOutput) } }));
  assert.equal((await generateQuestions(context)).source, 'ollama-llama3.2');
});
