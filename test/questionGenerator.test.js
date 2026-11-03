const test = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');
const { buildQuestionPrompt, heuristicFallbackQuestions, generateQuestions } =
  require('../src/services/questionGeneratorService');

const context = {
  targetRole: 'Backend Developer', interviewType: 'Mixed',
  skills: ['Node.js', 'MongoDB'],
  projects: [{ title: 'Nexus Messaging Platform', technologies: ['Express', 'Socket.io'],
    description: 'Built JWT authentication and real-time messaging.' }],
  experience: [{ role: 'Developer Intern', organisation: 'Elastik Teams', duration: '2025 - 2026',
    responsibilities: ['Resolved database query issues.', 'Designed REST APIs.'] }],
  experienceSummary: 'Legacy summary should not replace detailed experience',
  education: [{ degree: 'B.Tech', institution: 'Example University', year: '2026' }],
  candidateSummary: 'Interested in backend systems.', strengths: ['API design'],
  skillAreasToProbe: ['Query optimization'],
};

const SLOT_TYPES = ['technical', 'technical', 'project', 'project', 'experience', 'behavioral'];
function modelOutput() {
  return { questions: [
    'How would you design REST endpoints with Node.js and MongoDB and test the response contract?',
    'How would you trace a slow database query and verify that an optimization solved the issue?',
    'What was your contribution to Nexus Messaging Platform, and why did you choose that design?',
    'How would you test Nexus Messaging Platform under failure and identify its limitations?',
    'What challenge did you face as a Developer Intern, and how did you verify your fix?',
    'Describe a time you handled feedback, communicated your reasoning, and what you learned?',
  ] };
}

function checkFallback(input) {
  const result = heuristicFallbackQuestions(input);
  assert.equal(result.source, 'heuristic-fallback');
  assert.equal(result.questions.length, 6);
  assert.equal(new Set(result.questions.map((q) => q.question)).size, 6);
  for (const q of result.questions) {
    assert.deepEqual(Object.keys(q).sort(), ['basedOn', 'question', 'type']);
    assert.ok(q.question && q.basedOn);
    assert.ok(['technical', 'project', 'experience', 'behavioral'].includes(q.type));
    assert.doesNotMatch(q.question, /undefined|\[object Object\]|What is /);
  }
  assert.deepEqual(result, heuristicFallbackQuestions(input));
  return result.questions;
}

test('prompt includes concise role plan and structured resume evidence', () => {
  const prompt = buildQuestionPrompt(context);
  for (const value of ['Backend Developer', 'Mixed', 'Node.js', 'MongoDB',
    'Nexus Messaging Platform', 'Express', 'Socket.io', context.projects[0].description,
    'Developer Intern', 'Elastik Teams', '2025 - 2026', ...context.experience[0].responsibilities,
    'B.Tech', 'Example University', '2026']) {
    assert.ok(prompt.includes(value), `Missing ${value}`);
  }
  assert.match(prompt, /exactly six distinct interview questions/);
  assert.match(prompt, /1\. technical\n2\. technical\n3\. project\n4\. project\n5\. experience\n6\. behavioral/);
  assert.match(prompt, /questions array must contain six strings only/);
  assert.match(prompt, /Do not return objects, type labels, evidence anchors/);
  assert.match(prompt, /one concise sentence, at most 180 characters/);
  assert.match(prompt, /application assigns question types and evidence anchors/);
  assert.match(prompt, /without claiming candidate experience not shown/);
  assert.ok(!prompt.includes(context.candidateSummary));
  assert.ok(!prompt.includes(context.strengths[0]));
  assert.ok(!prompt.includes(context.experienceSummary));
});

test('legacy summary is used without detailed experience, including default empty arrays', () => {
  for (const experience of [undefined, [], null, 'invalid', [null, {}]]) {
    const legacy = { experience, experienceSummary: 'Engineer at Legacy Co (2023)' };
    assert.match(buildQuestionPrompt(legacy), /Engineer at Legacy Co \(2023\)/);
    const questions = checkFallback(legacy);
    assert.equal(questions[4].type, 'experience');
    assert.match(questions[4].question, /Engineer at Legacy Co/);
  }
});

test('ordered slots adapt to missing projects or experience', () => {
  assert.match(buildQuestionPrompt({ skills: ['Node.js'] }),
    /1\. technical\n2\. technical\n3\. technical\n4\. technical\n5\. technical\n6\. behavioral/);
  assert.match(buildQuestionPrompt({ skills: ['Node.js'], experience: [{ role: 'Developer' }] }),
    /1\. technical\n2\. technical\n3\. technical\n4\. technical\n5\. experience\n6\. behavioral/);
  assert.match(buildQuestionPrompt({ skills: ['Node.js'], projects: [{ title: 'Scheduler' }] }),
    /1\. technical\n2\. technical\n3\. technical\n4\. project\n5\. project\n6\. behavioral/);
});

test('fallback questions are concise, grounded, and preserve the required distribution', () => {
  const questions = checkFallback(context);
  assert.deepEqual(questions.map((q) => q.type), SLOT_TYPES);
  assert.ok(questions.every((q) => q.question.length <= 240 && q.basedOn.length <= 120));
  assert.ok(questions[0].question.includes('REST API Design'));
  assert.ok(questions[0].basedOn.length < 80);
  assert.ok(questions[2].question.includes(context.projects[0].title));
  assert.ok(questions[3].question.includes(context.projects[0].title));
  assert.equal(questions[2].basedOn, context.projects[0].title);
  assert.equal(questions[3].basedOn, context.projects[0].title);
  assert.match(questions[1].question, /Software Architecture|REST API Design|Databases & Data Modelling/);
  assert.equal(questions[4].basedOn, 'Developer Intern');
  assert.match(questions[4].question, /Developer Intern.*Elastik Teams/);
  assert.equal(questions[5].type, 'behavioral');
});

test('sparse and malformed contexts are safe and always produce six distinct questions', () => {
  for (const input of [undefined, null, {}, 42,
    { skills: ['Python'] }, { education: [{ degree: 'B.Sc' }] },
    { projects: [{ description: 'Built a scheduling tool.' }] },
    { skills: {}, projects: 'invalid', experience: 12, education: null, strengths: false },
    { skills: [null, {}, 42], projects: [null, {}, { technologies: 'bad', title: 42 }],
      experience: [null, { responsibilities: {} }], education: [null, 42],
      targetRole: {}, interviewType: [], candidateSummary: {}, skillAreasToProbe: {} }]) {
    assert.equal(typeof buildQuestionPrompt(input), 'string');
    const questions = checkFallback(input);
    assert.equal(questions.filter((q) => q.type === 'experience').length, 0);
  }
});

test('public generation sends a compact schema and assigns question types by slot', async (t) => {
  const output = modelOutput();
  const post = t.mock.method(axios, 'post', async (url, body, config) => {
    assert.equal(body.prompt, buildQuestionPrompt(context));
    assert.equal(body.format.type, 'object');
    assert.equal(body.format.properties.questions.minItems, 6);
    assert.equal(body.format.properties.questions.maxItems, 6);
    assert.equal(body.format.properties.questions.items.type, 'string');
    assert.equal(body.format.properties.questions.items.properties, undefined);
    assert.deepEqual(body.options, { num_predict: 512, num_ctx: 4096, temperature: 0.2 });
    assert.equal(body.keep_alive, '10m');
    assert.ok(Number.isInteger(config.timeout));
    assert.ok(config.timeout <= 90000);
    return { status: 200, data: { response: JSON.stringify(output) } };
  });
  const result = await generateQuestions(context);
  assert.equal(result.source, 'ollama-llama3.2');
  assert.deepEqual(result.questions.map((q) => q.question), output.questions);
  assert.deepEqual(result.questions.map((q) => q.type), SLOT_TYPES);
  assert.ok(result.questions.every((q) => q.basedOn && q.basedOn.length <= 80));
  assert.equal(post.mock.callCount(), 1);
});

test('streamed Ollama NDJSON records are joined and validated before returning AI source', async (t) => {
  const { Readable } = require('node:stream');
  const output = modelOutput();
  output.questions[0] = `${output.questions[0].replace(/[?!.]+$/, '')} for café input?`;
  const serialized = JSON.stringify(output);
  const records = Buffer.from([
    JSON.stringify({ response: serialized.slice(0, 60), done: false }),
    JSON.stringify({ response: serialized.slice(60), done: true }),
  ].join('\n'), 'utf8');
  const unicodeByte = records.indexOf(Buffer.from('é')) + 1;
  const post = t.mock.method(axios, 'post', async (url, body, config) => {
    assert.equal(body.stream, true);
    assert.equal(config.responseType, 'stream');
    return { status: 200, data: Readable.from([
      records.subarray(0, unicodeByte), records.subarray(unicodeByte, unicodeByte + 1), records.subarray(unicodeByte + 1),
    ]) };
  });
  const result = await generateQuestions(context);
  assert.equal(result.source, 'ollama-llama3.2');
  assert.equal(result.questions[0].question, output.questions[0]);
  assert.deepEqual(result.questions.map((q) => q.type), SLOT_TYPES);
  assert.equal(post.mock.callCount(), 1);
});

test('stream ending without done falls back as incomplete response', async (t) => {
  const { Readable } = require('node:stream');
  const log = t.mock.method(console, 'error', () => {});
  const previous = process.env.DEBUG_QUESTION_GENERATION;
  process.env.DEBUG_QUESTION_GENERATION = '1';
  t.after(() => {
    if (previous === undefined) delete process.env.DEBUG_QUESTION_GENERATION;
    else process.env.DEBUG_QUESTION_GENERATION = previous;
  });
  t.mock.method(axios, 'post', async () => ({ status: 200,
    data: Readable.from([JSON.stringify({ response: '{"questions":[]}', done: false })]) }));
  assert.deepEqual(await generateQuestions(context), heuristicFallbackQuestions(context));
  assert.match(log.mock.calls.at(-1).arguments[0], /categoryId=legacy-mixed .*validationReason=incomplete-stream/);
});

test('malformed Ollama stream events use response-error fallback without leaking event data', async (t) => {
  const { Readable } = require('node:stream');
  const log = t.mock.method(console, 'error', () => {});
  const previous = process.env.DEBUG_QUESTION_GENERATION;
  process.env.DEBUG_QUESTION_GENERATION = '1';
  t.after(() => {
    if (previous === undefined) delete process.env.DEBUG_QUESTION_GENERATION;
    else process.env.DEBUG_QUESTION_GENERATION = previous;
  });
  t.mock.method(axios, 'post', async () => ({ status: 200,
    data: Readable.from(['private malformed event {\n']) }));
  assert.deepEqual(await generateQuestions(context), heuristicFallbackQuestions(context));
  assert.match(log.mock.calls.at(-1).arguments[0], /categoryId=legacy-mixed .*validationReason=ollama-response-error/);
  assert.ok(log.mock.calls.every((call) => !call.arguments[0].includes('private malformed event')));
});

test('total deadline aborts an active response stream and selects fallback', async (t) => {
  const { PassThrough } = require('node:stream');
  const log = t.mock.method(console, 'error', () => {});
  const previous = process.env.DEBUG_QUESTION_GENERATION;
  process.env.DEBUG_QUESTION_GENERATION = '1';
  t.after(() => {
    if (previous === undefined) delete process.env.DEBUG_QUESTION_GENERATION;
    else process.env.DEBUG_QUESTION_GENERATION = previous;
  });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.mock.method(axios, 'post', async (url, body, config) => {
    const stream = new PassThrough();
    config.signal.addEventListener('abort', () => stream.destroy(new Error('aborted')));
    return { status: 200, data: stream };
  });
  const pending = generateQuestions(context);
  t.mock.timers.tick(120000);
  const result = await pending;
  assert.deepEqual(result, heuristicFallbackQuestions(context));
  assert.match(log.mock.calls.at(-1).arguments[0], /categoryId=legacy-mixed .*validationReason=request-timeout/);
});

test('empty or invalid AI results fall back', async (t) => {
  const post = t.mock.method(axios, 'post');
  for (const result of [{ questions: [] }, {}, { questions: 'invalid' }, null]) {
    post.mock.mockImplementation(async () => ({ data: { response: JSON.stringify(result) } }));
    assert.deepEqual(await generateQuestions(context), heuristicFallbackQuestions(context));
  }
  assert.equal(post.mock.callCount(), 4);
});

test('request failures are not retried and return deterministic fallback', async (t) => {
  const post = t.mock.method(axios, 'post', async () => { throw new Error('offline'); });
  assert.deepEqual(await generateQuestions(context), heuristicFallbackQuestions(context));
  assert.equal(post.mock.callCount(), 1);
});

test('malformed JSON gets at most one retry, while invalid questions fall back without retry', async (t) => {
  const post = t.mock.method(axios, 'post', async () => ({ data: { response: 'not json' } }));
  assert.deepEqual(await generateQuestions(context), heuristicFallbackQuestions(context));
  assert.equal(post.mock.callCount(), 2);
  post.mock.resetCalls();
  post.mock.mockImplementation(async () => ({ data: { response: JSON.stringify({ questions: [] }) } }));
  assert.deepEqual(await generateQuestions(context), heuristicFallbackQuestions(context));
  assert.equal(post.mock.callCount(), 1);
});

test('model output does not contain type labels; labels are assigned deterministically', async (t) => {
  const output = modelOutput();
  const post = t.mock.method(axios, 'post', async (url, body) => {
    assert.match(body.prompt, /Do not return objects, type labels/);
    assert.equal(body.format.properties.questions.items.type, 'string');
    return { status: 200, data: { response: JSON.stringify(output) } };
  });
  const result = await generateQuestions(context);
  assert.equal(result.source, 'ollama-llama3.2');
  assert.deepEqual(result.questions.map((q) => q.type), SLOT_TYPES);
  assert.equal(post.mock.callCount(), 1);
});

test('model-supplied type fields are rejected and safely fall back without retry', async (t) => {
  const previous = process.env.DEBUG_QUESTION_GENERATION;
  process.env.DEBUG_QUESTION_GENERATION = '1';
  t.after(() => {
    if (previous === undefined) delete process.env.DEBUG_QUESTION_GENERATION;
    else process.env.DEBUG_QUESTION_GENERATION = previous;
  });
  const log = t.mock.method(console, 'error', () => {});
  const output = modelOutput();
  output.questions = output.questions.map((question, index) => ({ question, type: SLOT_TYPES[index] }));
  const post = t.mock.method(axios, 'post', async () => ({ status: 200,
    data: { response: JSON.stringify(output) } }));
  assert.deepEqual(await generateQuestions(context), heuristicFallbackQuestions(context));
  assert.equal(post.mock.callCount(), 1);
  assert.match(log.mock.calls.at(-1).arguments[0], /categoryId=legacy-mixed .*validationReason=question-validation-error reason=invalid-item-shape/);
  assert.ok(log.mock.calls.every((call) => !call.arguments[0].includes('private resume') && !call.arguments[0].includes('Nexus Messaging')));
});

test('validation fallback is silent by default and logs only a category when debug is exactly 1', async (t) => {
  const previous = process.env.DEBUG_QUESTION_GENERATION;
  t.after(() => {
    if (previous === undefined) delete process.env.DEBUG_QUESTION_GENERATION;
    else process.env.DEBUG_QUESTION_GENERATION = previous;
  });
  const log = t.mock.method(console, 'error', () => {});
  const post = t.mock.method(axios, 'post', async () => ({
    status: 200,
    data: { response: JSON.stringify({ questions: [], privateModelData: 'must not be logged' }) },
  }));
  const expected = heuristicFallbackQuestions(context);
  for (const flag of [undefined, '0', 'true']) {
    if (flag === undefined) delete process.env.DEBUG_QUESTION_GENERATION;
    else process.env.DEBUG_QUESTION_GENERATION = flag;
    assert.deepEqual(await generateQuestions(context), expected);
  }
  assert.equal(log.mock.callCount(), 0);
  process.env.DEBUG_QUESTION_GENERATION = '1';
  assert.deepEqual(await generateQuestions(context), expected);
  const logs = log.mock.calls.map((call) => call.arguments[0]);
  assert.ok(logs.some((line) => /categoryId=legacy-mixed durationMs=\d+ httpStatus=200 completion=done/.test(line)));
  assert.ok(logs.some((line) => /categoryId=legacy-mixed durationMs=\d+ questionCount=6 validationReason=question-validation-error reason=invalid-envelope questionCount=0 fallbackSelected=true/.test(line)));
  assert.ok(logs.every((line) => !line.includes('privateModelData') && !line.includes('private candidate')));
  assert.equal(post.mock.callCount(), 4); // Semantic failures do not retry.
});

test('debug categorizes request, JSON and other failures safely without changing retries or fallback', async (t) => {
  const previous = process.env.DEBUG_QUESTION_GENERATION;
  t.after(() => {
    if (previous === undefined) delete process.env.DEBUG_QUESTION_GENERATION;
    else process.env.DEBUG_QUESTION_GENERATION = previous;
  });
  process.env.DEBUG_QUESTION_GENERATION = '1';
  const log = t.mock.method(console, 'error', () => {});
  const post = t.mock.method(axios, 'post');
  const requestError = new axios.AxiosError('private request details', 'ECONNABORTED', { secret: 'hidden' });
  const cases = [
    [async () => { throw requestError; }, 'request-timeout'],
    [async () => ({ data: { response: 'private invalid JSON' } }), 'json-parse-error'],
    [async () => { throw new Error('private internal details'); }, 'question-generation-error'],
  ];
  for (const [implementation, category] of cases) {
    const before = post.mock.callCount();
    post.mock.mockImplementation(implementation);
    assert.deepEqual(await generateQuestions(context), heuristicFallbackQuestions(context));
    assert.equal(post.mock.callCount(), before + (category === 'json-parse-error' ? 2 : 1));
    assert.match(log.mock.calls.at(-1).arguments[0], new RegExp(`categoryId=legacy-mixed .*validationReason=${category}`));
    if (category === 'request-timeout') {
      assert.ok(log.mock.calls.some((call) => /categoryId=legacy-mixed durationMs=\d+ .*completion=request-timeout/.test(call.arguments[0])));
    }
  }
  assert.equal(log.mock.calls.filter((call) => call.arguments[0].includes('fallbackSelected=true')).length, cases.length);
});

test('debug logs only safe validation metadata and allowlisted request codes/statuses', async (t) => {
  const previous = process.env.DEBUG_QUESTION_GENERATION;
  t.after(() => {
    if (previous === undefined) delete process.env.DEBUG_QUESTION_GENERATION;
    else process.env.DEBUG_QUESTION_GENERATION = previous;
  });
  process.env.DEBUG_QUESTION_GENERATION = '1';
  const log = t.mock.method(console, 'error', () => {});
  const post = t.mock.method(axios, 'post');
  const invalid = { questions: modelOutput().questions.map((question) => question) };
  invalid.questions[0] = { question: 'private fabricated candidate data', type: 'technical', basedOn: 'private fabricated candidate data' };
  post.mock.mockImplementation(async () => ({ data: { response: JSON.stringify(invalid) } }));
  assert.deepEqual(await generateQuestions(context), heuristicFallbackQuestions(context));
  assert.match(log.mock.calls.at(-1).arguments[0], /categoryId=legacy-mixed durationMs=\d+ questionCount=6 validationReason=question-validation-error reason=invalid-item-shape questionIndex=0 questionCount=6 fallbackSelected=true/);
  for (const code of ['ECONNABORTED', 'ETIMEDOUT', 'ECONNREFUSED', 'ERR_BAD_RESPONSE', 'private secret']) {
    const error = new axios.AxiosError('private message', code, { credential: 'private' });
    error.response = { status: 503, data: 'private response', headers: { secret: 'private' } };
    post.mock.mockImplementation(async () => { throw error; });
    assert.deepEqual(await generateQuestions(context), heuristicFallbackQuestions(context));
    const suffix = code === 'private secret' ? '' : ` errorCode=${code}`;
    assert.match(log.mock.calls.at(-1).arguments[0], /categoryId=legacy-mixed .*httpStatus=503.*validationReason=ollama-api-error/);
  }
  const error = new axios.AxiosError('private', 'private');
  error.response = { status: '503 private' };
  post.mock.mockImplementation(async () => { throw error; });
  assert.deepEqual(await generateQuestions(context), heuristicFallbackQuestions(context));
  assert.match(log.mock.calls.at(-1).arguments[0], /categoryId=legacy-mixed .*validationReason=ollama-api-error fallbackSelected=true stage=fallback-selected source=heuristic-fallback$/);
});
