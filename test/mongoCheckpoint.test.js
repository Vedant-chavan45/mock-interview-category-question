const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const mongoose = require('mongoose');
const Resume = require('../src/models/Resume');
const controller = require('../src/controllers/resumeController');
const parser = require('../src/services/resumeParserService');
const ollama = require('../src/services/ollamaService');
const contextBuilder = require('../src/services/contextBuilder');
const pdf = require('../src/services/pdfService');
const questions = require('../src/services/questionGeneratorService');
const database = require('../src/config/database');

const owner = '000000000000000000000001';
const other = '000000000000000000000002';
const id = '100000000000000000000001';
const text = [
  'Alex Example', 'alex@example.com', 'Skills', 'JavaScript, MongoDB',
  'Projects', 'Resume App | Node.js, MongoDB', 'Built an application.',
  'Experience', 'Developer - Example Co', '2024 - 2025',
  '- Built REST APIs.', '- Improved database queries.',
  'Education', 'B.Tech - Example University', '2020 - 2024',
  'Certifications', 'Example Certification',
].join('\n');
const parsedResume = parser.parse(text);
const analysis = ollama.heuristicFallbackAnalysis(parsedResume);
const resumeContext = contextBuilder.build(parsedResume, analysis, {
  interviewType: 'Technical', targetRole: 'Developer',
});
const record = {
  userId: owner,
  file: { originalName: 'resume.pdf', mimeType: 'application/pdf', sizeBytes: 20 },
  pageCount: 1, parsedResume, analysis, resumeContext,
};
function response() {
  return {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}
function request(userId = owner, resumeId = id) {
  return { user: { id: userId }, params: { id: resumeId } };
}

test('context preserves detailed experience and the existing summary format', () => {
  assert.deepEqual(resumeContext.experience, [{
    role: 'Developer', organisation: 'Example Co', duration: '2024 - 2025',
    responsibilities: ['Built REST APIs.', 'Improved database queries.'],
  }]);
  assert.equal(resumeContext.experienceSummary, 'Developer at Example Co (2024 - 2025)');
  const context = contextBuilder.build({ ...parsedResume, experience: [
    ...parsedResume.experience,
    { role: 'Volunteer', organisation: '', duration: '', responsibilities: [] },
    { role: 'Intern', organisation: 'Other Co', duration: '', responsibilities: [] },
    { role: 'Freelancer', organisation: '', duration: '2023', responsibilities: [] },
  ] }, analysis);
  assert.equal(context.experienceSummary,
    'Developer at Example Co (2024 - 2025); Volunteer; Intern at Other Co; Freelancer (2023)');
});

test('context safely defaults missing or non-array experience to an empty array', () => {
  const { experience, ...withoutExperience } = parsedResume;
  for (const input of [withoutExperience, ...[undefined, null, {}, 'Developer', 42, []]
    .map((value) => ({ ...parsedResume, experience: value }))]) {
    const context = contextBuilder.build(input, analysis);
    assert.deepEqual(context.experience, []);
    assert.equal(context.experienceSummary, '');
  }
});

test('legacy resume contexts hydrate and validate with empty experience', async () => {
  const { experience, ...legacyContext } = resumeContext;
  const legacyRecord = { ...record, resumeContext: legacyContext };
  const doc = Resume.hydrate(legacyRecord);
  await doc.validate();
  assert.deepEqual(doc.resumeContext.experience.toObject(), []);
  assert.equal(doc.resumeContext.experienceSummary, resumeContext.experienceSummary);
  assert.deepEqual(doc.resumeContext.toObject(), { ...legacyContext, experience: [] });
});

test('schema preserves actual pipeline output without nested IDs or binary fields', async () => {
  const doc = new Resume({ ...record, buffer: Buffer.from('excluded'), rawText: text });
  await doc.validate();
  const saved = doc.toObject();
  assert.deepEqual(saved.resumeContext.experience, parsedResume.experience);
  for (const entry of saved.resumeContext.experience) {
    assert.equal(Object.hasOwn(entry, '_id'), false);
  }
  for (const key of ['parsedResume', 'analysis', 'resumeContext', 'file']) {
    assert.deepEqual(saved[key], record[key]);
  }
  assert.equal(saved.userId.toString(), owner);
  assert.equal(saved.buffer, undefined);
  assert.equal(saved.rawText, undefined);
  assert.ok(Resume.schema.path('createdAt'));
  assert.ok(Resume.schema.path('updatedAt'));
  assert.ok(Resume.schema.indexes().some(([index]) =>
    index.userId === 1 && index.createdAt === -1));
  await assert.rejects(new Resume({ ...record, userId: undefined }).validate());
});

test('all reads return 404 for malformed IDs without querying', async (t) => {
  t.mock.method(Resume, 'findOne', () => { throw new Error('Query must not run'); });
  for (const handler of [controller.getResume, controller.getContext, controller.getQuestions]) {
    for (const badId of ['hello', '1', 'abcdefghijkl', 'g'.repeat(24)]) {
      const res = response();
      await handler(request(owner, badId), res);
      assert.equal(res.statusCode, 404);
      assert.deepEqual(res.body, { error: 'Resume not found.' });
    }
  }
});

test('all reads enforce ownership, hide missing/foreign records, and use saved context', async (t) => {
  t.mock.method(Resume, 'findOne', (filter) => {
    assert.deepEqual(Object.keys(filter).sort(), ['_id', 'userId']);
    return { lean: async () => filter._id === id && filter.userId === owner ? record : null };
  });
  const generate = t.mock.method(questions, 'generateQuestions', async (context) => {
    assert.strictEqual(context, resumeContext);
    return { questions: [], source: 'test' };
  });
  for (const handler of [controller.getResume, controller.getContext, controller.getQuestions]) {
    for (const req of [request(other), request(owner, '200000000000000000000001')]) {
      const res = response();
      await handler(req, res);
      assert.equal(res.statusCode, 404);
    }
    const res = response();
    await handler(request(), res);
    assert.equal(res.statusCode, 200);
    if (handler === controller.getResume) assert.deepEqual(res.body, { parsedResume, analysis });
    if (handler === controller.getContext) assert.deepEqual(res.body, resumeContext);
  }
  assert.equal(generate.mock.callCount(), 1);
});

test('upload saves metadata and ownership, excludes binary/text, preserves response', async (t) => {
  t.mock.method(pdf, 'extractText', async () => ({ text, pageCount: 1 }));
  t.mock.method(ollama, 'analyseResume', async () => analysis);
  t.mock.method(Resume, 'create', async (data) => {
    assert.deepEqual(data, record);
    const doc = new Resume(data);
    await doc.validate();
    assert.deepEqual(doc.toObject().resumeContext.experience, parsedResume.experience);
    assert.equal(data.buffer, undefined);
    assert.equal(data.rawText, undefined);
    return { _id: new mongoose.Types.ObjectId(id) };
  });
  const res = response();
  await controller.uploadResume({
    ...request(),
    file: { originalname: 'resume.pdf', mimetype: 'application/pdf', size: 20, buffer: Buffer.from('not persisted') },
    body: { interviewType: 'Technical', targetRole: 'Developer' },
  }, res);
  assert.equal(res.statusCode, 201);
  assert.deepEqual(res.body, { resumeId: id, pageCount: 1, parsedResume, analysis });
});

test('database read failures return clean JSON errors', async (t) => {
  t.mock.method(console, 'error', () => {});
  t.mock.method(Resume, 'findOne', () => ({
    lean: async () => { throw new Error('private connection details'); },
  }));
  for (const handler of [controller.getResume, controller.getContext, controller.getQuestions]) {
    const res = response();
    await handler(request(), res);
    assert.equal(res.statusCode, 500);
    assert.equal(JSON.stringify(res.body).includes('private'), false);
  }
});

test('connection uses configured database/default and hides driver error details', async (t) => {
  const oldUri = process.env.MONGODB_URI;
  const oldDb = process.env.MONGODB_DB_NAME;
  t.after(() => {
    if (oldUri === undefined) delete process.env.MONGODB_URI; else process.env.MONGODB_URI = oldUri;
    if (oldDb === undefined) delete process.env.MONGODB_DB_NAME; else process.env.MONGODB_DB_NAME = oldDb;
  });
  delete process.env.MONGODB_URI;
  await assert.rejects(database.connectDatabase(), /MONGODB_URI must be configured/);
  // Opaque test value is passed only to the mocked connector; no server is contacted.
  process.env.MONGODB_URI = 'test-only-configuration';
  delete process.env.MONGODB_DB_NAME;
  const connect = t.mock.method(mongoose, 'connect', async (uri, options) => {
    assert.equal(uri, 'test-only-configuration');
    assert.equal(options.dbName, process.env.MONGODB_DB_NAME || 'mock_interview_platform');
  });
  await database.connectDatabase();
  process.env.MONGODB_DB_NAME = 'custom_test_database';
  await database.connectDatabase();
  connect.mock.mockImplementation(async () => { throw new Error('private credentials'); });
  t.mock.method(mongoose, 'disconnect', async () => {});
  await assert.rejects(database.connectDatabase(), (err) =>
    err.message === 'MongoDB connection failed. Check database configuration and network access.');
});

test('missing URI exits startup without listening', () => {
  const result = spawnSync(process.execPath, ['server.js'], {
    cwd: require('node:path').join(__dirname, '..'),
    env: { ...process.env, MONGODB_URI: '' },
    encoding: 'utf8', timeout: 15000,
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /MONGODB_URI must be configured/);
  assert.doesNotMatch(result.stdout, /listening/);
});

test('HTTP health state and existing login/JWT contract', async (t) => {
  const app = require('../server');
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const base = 'http://127.0.0.1:' + server.address().port;
  const oldState = mongoose.connection.readyState;
  t.after(() => { mongoose.connection.readyState = oldState; });
  for (const [state, status, name] of [[0, 503, 'disconnected'], [1, 200, 'connected'], [2, 503, 'connecting'], [3, 503, 'disconnecting']]) {
    mongoose.connection.readyState = state;
    const res = await fetch(base + '/health');
    assert.equal(res.status, status);
    assert.equal((await res.json()).mongodb, name);
  }
  mongoose.connection.readyState = oldState;
  const users = require('../src/services/userStore');
  const auth = require('../src/services/authService');
  const demo = {
    id: process.env.DEMO_USER_ID || owner, name: 'Demo User',
    email: 'demo@example.com', passwordHash: auth.hashPassword('demo1234'),
  };
  t.mock.method(users, 'findByEmail', async (email, options) => {
    assert.equal(email, demo.email);
    assert.equal(options.includePassword, true);
    return demo;
  });
  const login = await fetch(base + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: demo.email, password: 'demo1234' }),
  });
  assert.equal(login.status, 200);
  const result = await login.json();
  assert.equal(result.user.id, process.env.DEMO_USER_ID || owner);
  const me = await fetch(base + '/api/auth/me', { headers: { Authorization: 'Bearer ' + result.token } });
  assert.deepEqual((await me.json()).user, result.user);
  for (const suffix of ['', '/context', '/questions']) {
    const res = await fetch(base + '/api/resume/hello' + suffix, { headers: { Authorization: 'Bearer ' + result.token } });
    assert.equal(res.status, 404);
  }
  assert.equal((await fetch(base + '/api/resume/' + id)).status, 401);
});
