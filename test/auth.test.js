const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const User = require('../src/models/User');
const store = require('../src/services/userStore');
const auth = require('../src/services/authService');
const controller = require('../src/controllers/authController');
const { seedDemoUser, getDemoConfig, initializeUsers } = require('../src/services/seedDemoUser');

const id = '100000000000000000000001';
const demoId = '000000000000000000000001';
const password = 'correct-password';
const hash = auth.hashPassword(password);
const valid = { name: '  Alex Example  ', email: ' Alex@Example.COM ', password, confirmPassword: password };
function response() {
  return { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
}
function demoEnvironment(t) {
  for (const [key, value] of Object.entries({ DEMO_USER_ID: demoId, DEMO_USER_EMAIL: 'demo@example.com', DEMO_USER_NAME: 'Demo User', DEMO_USER_PASSWORD: 'demo1234' })) {
    const old = process.env[key];
    t.after(() => { if (old === undefined) delete process.env[key]; else process.env[key] = old; });
    process.env[key] = value;
  }
}

test('User schema normalizes required fields, generates ObjectIds and hides passwordHash', async () => {
  const user = new User({ name: valid.name, email: valid.email, passwordHash: hash });
  await user.validate();
  assert.equal(user.name, 'Alex Example');
  assert.equal(user.email, 'alex@example.com');
  assert.ok(user._id instanceof mongoose.Types.ObjectId);
  assert.equal(User.schema.path('passwordHash').options.select, false);
  assert.ok(User.schema.path('createdAt'));
  assert.ok(User.schema.path('updatedAt'));
  assert.ok(User.schema.indexes().some(([keys, options]) => keys.email === 1 && options.unique));
  for (const key of ['name', 'email', 'passwordHash']) {
    await assert.rejects(new User({ name: 'Alex', email: 'alex@example.com', passwordHash: hash, [key]: '' }).validate());
  }
});

test('user store uses normalized Mongo lookups and selects hashes only explicitly', async (t) => {
  let selected = 0;
  t.mock.method(User, 'findOne', filter => {
    assert.deepEqual(filter, { email: 'alex@example.com' });
    return { select(value) { assert.equal(value, '+passwordHash'); selected++; return this; } };
  });
  await store.findByEmail(valid.email);
  assert.equal(selected, 0);
  await store.findByEmail(valid.email, { includePassword: true });
  assert.equal(selected, 1);
  t.mock.method(User, 'findById', value => { assert.equal(value, id); return { id }; });
  assert.equal((await store.findById(id)).id, id);
  t.mock.method(User, 'create', data => {
    assert.deepEqual(data, { name: 'Alex Example', email: 'alex@example.com', passwordHash: hash });
    return data;
  });
  await store.createUser({ ...valid, passwordHash: hash, _id: demoId });
});

test('signup returns 201, public user and JWT for the MongoDB ID; persists only a bcrypt hash', async (t) => {
  t.mock.method(store, 'findByEmail', async email => { assert.equal(email, 'alex@example.com'); return null; });
  t.mock.method(store, 'createUser', async data => {
    assert.deepEqual(Object.keys(data).sort(), ['email', 'name', 'passwordHash']);
    assert.equal(data.name, 'Alex Example');
    assert.equal(data.email, 'alex@example.com');
    assert.notEqual(data.passwordHash, password);
    assert.ok(auth.verifyPassword(password, data.passwordHash));
    return { id, ...data };
  });
  const res = response();
  await controller.signup({ body: valid }, res);
  assert.equal(res.statusCode, 201);
  assert.deepEqual(res.body.user, { id, name: 'Alex Example', email: 'alex@example.com' });
  const claims = auth.verifyToken(res.body.token);
  assert.equal(claims.sub, id);
  assert.equal(claims.passwordHash, undefined);
  assert.equal(JSON.stringify(res.body).includes('passwordHash'), false);
});

test('signup rejects missing fields, invalid types/email/name, short/oversized passwords and confirmation errors', async (t) => {
  t.mock.method(store, 'findByEmail', () => { throw new Error('Validation must precede lookup'); });
  const cases = [undefined, {}, ...Object.keys(valid).map(key => ({ ...valid, [key]: undefined })),
    { ...valid, name: {} }, { ...valid, name: '  ' }, { ...valid, name: 'a'.repeat(101) },
    { ...valid, email: ['alex@example.com'] }, { ...valid, email: 'invalid' }, { ...valid, email: 'a b@example.com' },
    { ...valid, email: 'a'.repeat(255) + '@example.com' }, { ...valid, password: 12345678 },
    { ...valid, password: 'short', confirmPassword: 'short' },
    { ...valid, password: 'a'.repeat(73), confirmPassword: 'a'.repeat(73) },
    { ...valid, password: '\u00e9'.repeat(37), confirmPassword: '\u00e9'.repeat(37) },
    { ...valid, confirmPassword: 'different' }];
  for (const body of cases) {
    const res = response(); await controller.signup({ body }, res);
    assert.equal(res.statusCode, 400);
    assert.equal(typeof res.body.error, 'string');
  }
});

test('signup accepts the exact 72-byte UTF-8 boundary', async (t) => {
  t.mock.method(store, 'findByEmail', async () => null);
  t.mock.method(store, 'createUser', async data => ({ id, ...data }));
  const boundary = '\u00e9'.repeat(36);
  const res = response();
  await controller.signup({ body: { ...valid, password: boundary, confirmPassword: boundary } }, res);
  assert.equal(res.statusCode, 201);
});

test('duplicate signup returns 409 both on precheck and a database race', async (t) => {
  const lookup = t.mock.method(store, 'findByEmail', async () => ({ id }));
  const create = t.mock.method(store, 'createUser', async () => { throw Object.assign(new Error('private'), { code: 11000 }); });
  const first = response(); await controller.signup({ body: valid }, first);
  assert.equal(first.statusCode, 409); assert.equal(create.mock.callCount(), 0);
  lookup.mock.mockImplementation(async () => null);
  const race = response(); await controller.signup({ body: valid }, race);
  assert.equal(race.statusCode, 409); assert.deepEqual(race.body, first.body);
});

test('login explicitly retrieves hash, normalizes email and preserves JWT/response and me contracts', async (t) => {
  t.mock.method(store, 'findByEmail', async (email, options) => {
    assert.equal(email, 'alex@example.com'); assert.deepEqual(options, { includePassword: true });
    return { id, name: 'Alex', email, passwordHash: hash };
  });
  const res = response(); await controller.login({ body: valid }, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(Object.keys(res.body).sort(), ['token', 'user']);
  assert.deepEqual(res.body.user, { id, name: 'Alex', email: 'alex@example.com' });
  assert.equal(auth.verifyToken(res.body.token).sub, id);
  const me = response(); controller.me({ user: res.body.user }, me);
  assert.deepEqual(me.body, { user: res.body.user });
});

test('wrong password and unknown email have identical 401 responses', async (t) => {
  const lookup = t.mock.method(store, 'findByEmail', async () => ({ id, passwordHash: hash }));
  const wrong = response(); await controller.login({ body: { ...valid, password: 'incorrect' } }, wrong);
  lookup.mock.mockImplementation(async () => null);
  const missing = response(); await controller.login({ body: valid }, missing);
  assert.equal(wrong.statusCode, 401); assert.equal(missing.statusCode, 401);
  assert.deepEqual(wrong.body, { error: 'Invalid email or password.' });
  assert.deepEqual(missing.body, wrong.body);
});

test('login rejects malformed fields and oversized bcrypt input without querying', async (t) => {
  const lookup = t.mock.method(store, 'findByEmail', () => { throw new Error('Must not query'); });
  for (const body of [{}, { email: {}, password }, { email: 'alex@example.com', password: {} }]) {
    const res = response(); await controller.login({ body }, res); assert.equal(res.statusCode, 400);
  }
  const res = response(); await controller.login({ body: { ...valid, password: 'a'.repeat(73) } }, res);
  assert.equal(res.statusCode, 401); assert.equal(lookup.mock.callCount(), 0);
});

test('database failures return sanitized auth errors', async (t) => {
  t.mock.method(store, 'findByEmail', async () => { throw new Error('mongodb://private-credentials'); });
  for (const handler of [controller.signup, controller.login]) {
    const res = response(); await handler({ body: valid }, res);
    assert.equal(res.statusCode, 500); assert.doesNotMatch(JSON.stringify(res.body), /private|mongodb/);
  }
});

test('demo seed uses exact ObjectId and repeated initialization never changes password or timestamps', async (t) => {
  demoEnvironment(t);
  let record = null;
  const indexes = t.mock.method(User, 'createIndexes', async () => {});
  t.mock.method(User, 'findById', async value => { assert.equal(value, demoId); return record; });
  t.mock.method(User, 'findOne', async filter => { assert.equal(filter.email, 'demo@example.com'); return record; });
  const create = t.mock.method(User, 'create', async data => {
    assert.equal(data._id, demoId); assert.ok(auth.verifyPassword('demo1234', data.passwordHash));
    record = { id: data._id, ...data, updatedAt: new Date() }; return record;
  });
  await initializeUsers();
  const original = { ...record };
  process.env.DEMO_USER_PASSWORD = 'changed-environment-password';
  process.env.DEMO_USER_NAME = 'Changed environment name';
  await initializeUsers();
  assert.deepEqual(record, original); assert.equal(create.mock.callCount(), 1); assert.equal(indexes.mock.callCount(), 2);
});

test('seed rejects identity conflicts and invalid configured ID without writes', async (t) => {
  demoEnvironment(t);
  const byId = t.mock.method(User, 'findById', async () => ({ id: demoId, email: 'someone@example.com' }));
  const byEmail = t.mock.method(User, 'findOne', async () => null);
  const create = t.mock.method(User, 'create', async () => { throw new Error('Must not write'); });
  await assert.rejects(seedDemoUser(), /fixed demo ID belongs to another email/);
  byId.mock.mockImplementation(async () => null);
  byEmail.mock.mockImplementation(async () => ({ id, email: 'demo@example.com' }));
  await assert.rejects(seedDemoUser(), /email belongs to another ID/);
  process.env.DEMO_USER_ID = id;
  assert.throws(getDemoConfig, /preserve resume ownership/);
  assert.equal(create.mock.callCount(), 0);
});

test('concurrent demo seed duplicate is accepted only when the winner has the same identity', async (t) => {
  demoEnvironment(t);
  let winner = null;
  t.mock.method(User, 'findById', async () => winner);
  t.mock.method(User, 'findOne', async () => winner);
  t.mock.method(User, 'create', async data => {
    winner = { id: demoId, ...data };
    throw Object.assign(new Error('duplicate'), { code: 11000 });
  });
  assert.equal((await seedDemoUser()).id, demoId);
});
