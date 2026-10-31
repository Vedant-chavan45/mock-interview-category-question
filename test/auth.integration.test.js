require('dotenv').config();
const test = require('node:test');
const assert = require('node:assert/strict');
const { readFile } = require('node:fs/promises');
const { randomUUID } = require('node:crypto');
const mongoose = require('mongoose');
const User = require('../src/models/User');
const Resume = require('../src/models/Resume');
const auth = require('../src/services/authService');
const { initializeUsers, getDemoConfig } = require('../src/services/seedDemoUser');

const uri = process.env.MONGODB_TEST_URI || process.env.MONGODB_URI;
const testDb = process.env.MONGODB_TEST_DB_NAME || 'mock_interview_platform_test';
function assertTestDatabase(connected = false) {
  assert.match(testDb, /(?:^|[_-])test(?:[_-]|$)/i, 'Refusing database without an explicit test name segment');
  assert.notEqual(testDb.toLowerCase(), 'mock_interview_platform', 'Refusing normal application database');
  assert.notEqual(testDb.toLowerCase(), (process.env.MONGODB_DB_NAME || 'mock_interview_platform').toLowerCase(), 'Test and development databases must differ');
  if (connected) {
    assert.equal(mongoose.connection.readyState, 1, 'Cleanup requires an active connection');
    assert.equal(mongoose.connection.name, testDb, 'Connected database must match verified test database');
  }
}

test('integration database configuration cannot target the normal database', () => assertTestDatabase());

test('MongoDB signup, persisted login, seed, reconnect and resume ownership', { skip: !uri && 'Set MONGODB_TEST_URI or MONGODB_URI to run MongoDB integration tests', timeout: 90000 }, async (t) => {
  assertTestDatabase();
  const userIds = new Set();
  const resumeIds = new Set();
  let server;
  let connected = false;
  async function connect() {
    try { await mongoose.connect(uri, { dbName: testDb, serverSelectionTimeoutMS: 10000 }); }
    catch { throw new Error('Test MongoDB connection failed. Check test configuration and network access.'); }
    connected = true;
    assertTestDatabase(true);
  }
  async function closeServer() {
    if (server) {
      const closing = server; server = null;
      await new Promise(resolve => { closing.closeAllConnections(); closing.close(resolve); });
    }
  }
  t.after(async () => {
    await closeServer();
    try {
      if (connected) {
        if (mongoose.connection.readyState !== 1) await connect();
        // No collection/database drops: delete only IDs created by this run.
        assertTestDatabase(true);
        if (resumeIds.size) await Resume.deleteMany({ _id: { $in: [...resumeIds] } });
        assertTestDatabase(true);
        if (userIds.size) await User.deleteMany({ _id: { $in: [...userIds] } });
      }
    } finally { await mongoose.disconnect(); }
  });
  await connect();
  const config = getDemoConfig();
  const existingDemo = await User.findById(config.id);
  // Insert the legacy ownership fixture before running the migration seed.
  const legacy = await Resume.create({ userId: config.id,
    file: { originalName: 'legacy.pdf', mimeType: 'application/pdf', sizeBytes: 10 },
    pageCount: 1, parsedResume: {}, analysis: {}, resumeContext: {},
  });
  resumeIds.add(legacy.id);
  // Track successful inserts by this run, not just an earlier absence check:
  // another process could win a concurrent seed, and its account must survive cleanup.
  const originalCreate = User.create.bind(User);
  const seedCreate = t.mock.method(User, 'create', async (...args) => {
    const created = await originalCreate(...args);
    if (created.id === config.id) userIds.add(created.id);
    return created;
  });
  try { await initializeUsers(); } finally { seedCreate.mock.restore(); }
  const demoBefore = await User.findById(config.id).select('+passwordHash').lean();
  await initializeUsers();
  const demoAfter = await User.findById(config.id).select('+passwordHash').lean();
  assert.deepEqual(demoAfter, demoBefore);
  assert.equal(demoAfter._id.toString(), '000000000000000000000001');
  assert.equal((await Resume.findById(legacy.id)).userId.toString(), config.id);

  const ollama = require('../src/services/ollamaService');
  t.mock.method(ollama, 'analyseResume', async parsed => ollama.heuristicFallbackAnalysis(parsed));
  t.mock.method(require('../src/services/questionGeneratorService'), 'generateQuestions', async () => ({ questions: [], source: 'test' }));
  const app = require('../server');
  let base;
  async function startServer() {
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    base = 'http://127.0.0.1:' + server.address().port;
  }
  await startServer();
  const post = (route, body) => fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const unique = randomUUID();
  const credentials = { name: 'Integration User', email: unique + '@example.com', password: 'integration-password', confirmPassword: 'integration-password' };
  const signup = await post('/api/auth/signup', { ...credentials, email: ' ' + credentials.email.toUpperCase() + ' ' });
  assert.equal(signup.status, 201);
  const first = await signup.json(); userIds.add(first.user.id);
  assert.equal(first.user.email, credentials.email);
  assert.equal(auth.verifyToken(first.token).sub, first.user.id);
  assert.equal(JSON.stringify(first).includes('passwordHash'), false);
  const stored = await User.findById(first.user.id).select('+passwordHash');
  assert.ok(auth.verifyPassword(credentials.password, stored.passwordHash));
  assert.notEqual(stored.passwordHash, credentials.password);
  assert.equal((await User.findById(first.user.id)).passwordHash, undefined);
  assert.equal((await post('/api/auth/signup', credentials)).status, 409);
  await assert.rejects(User.create({ name: 'Duplicate', email: credentials.email.toUpperCase(), passwordHash: stored.passwordHash }), err => err.code === 11000);
  const secondResponse = await post('/api/auth/signup', { ...credentials, email: 'other-' + credentials.email });
  assert.equal(secondResponse.status, 201);
  const second = await secondResponse.json(); userIds.add(second.user.id);

  const pdf = await readFile(require('node:path').join(__dirname, 'sample_resume.pdf'));
  const form = new FormData();
  form.append('resume', new Blob([pdf], { type: 'application/pdf' }), 'sample_resume.pdf');
  form.append('interviewType', 'Technical'); form.append('targetRole', 'Developer');
  const upload = await fetch(base + '/api/resume/upload', { method: 'POST', headers: { Authorization: 'Bearer ' + first.token }, body: form });
  assert.equal(upload.status, 201);
  const uploaded = await upload.json(); resumeIds.add(uploaded.resumeId);
  assert.equal((await Resume.findById(uploaded.resumeId)).userId.toString(), first.user.id);
  const get = (path, token) => fetch(base + path, { headers: { Authorization: 'Bearer ' + token } });
  for (const suffix of ['', '/context', '/questions']) {
    assert.equal((await get('/api/resume/' + uploaded.resumeId + suffix, first.token)).status, 200);
    assert.equal((await get('/api/resume/' + uploaded.resumeId + suffix, second.token)).status, 404);
  }
  const demoToken = auth.generateToken({ id: config.id, name: demoAfter.name, email: demoAfter.email });
  for (const suffix of ['', '/context', '/questions']) {
    assert.equal((await get('/api/resume/' + legacy.id + suffix, demoToken)).status, 200);
    assert.equal((await get('/api/resume/' + legacy.id + suffix, first.token)).status, 404);
  }
  if (!existingDemo) {
    const demoLogin = await post('/api/auth/login', { email: config.email, password: config.password });
    assert.equal(demoLogin.status, 200); assert.equal((await demoLogin.json()).user.id, config.id);
  }

  await closeServer(); await mongoose.disconnect(); await connect(); await initializeUsers(); await startServer();
  const login = await post('/api/auth/login', credentials);
  assert.equal(login.status, 200);
  const loggedIn = await login.json(); assert.equal(loggedIn.user.id, first.user.id);
  assert.equal((await get('/api/auth/me', loggedIn.token)).status, 200);
  assert.equal((await get('/api/resume/' + uploaded.resumeId, loggedIn.token)).status, 200);
  assert.equal((await get('/api/resume/' + legacy.id, demoToken)).status, 200);
});
