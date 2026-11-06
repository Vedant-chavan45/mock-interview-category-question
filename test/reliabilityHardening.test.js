'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const parser = require('../src/services/resumeParserService');
const pdf = require('../src/services/pdfService');
const validity = require('../src/services/resumeValidityService');
const { validateSecurityEnvironment } = require('../src/config/security');
const controller = require('../src/controllers/resumeController');
const Resume = require('../src/models/Resume');
const ai = require('../src/services/ollamaService');

const textResume = [
  'Alex Example', 'alex@example.com', 'Summary', 'Software engineering student seeking an internship.',
  'Education', 'B.Tech Computer Engineering - Example College',
  'Skills', 'JavaScript, SQL, Git, Node.js',
  'Projects', 'Ticket Tracker | Node.js, SQL', '- Built a ticket API and handled validation.',
  'Certifications', '- C++ (Basic) Certification - HackerRank', '- Cloud Computing - University',
].join('\n');

function response() { return { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } }; }

const request = { user: { id: '000000000000000000000001' },
  body: { targetRole: 'Software Engineer Intern', requiredSkillset: '["Git"]' },
  file: { mimetype: 'application/pdf', originalname: 'document.pdf', size: 50, buffer: Buffer.from('%PDF-1.4\nfixture') } };

test('certification extraction keeps bullet-only entries, wrapped text and deduplicates entries', () => {
  assert.deepEqual(parser.parse(textResume).certifications,
    ['C++ (Basic) Certification - HackerRank', 'Cloud Computing - University']);
  assert.deepEqual(parser.extractCertifications('- A cloud computing certificate,\n  awarded in 2026\n- Python Certificate'),
    ['A cloud computing certificate, awarded in 2026', 'Python Certificate']);
  assert.deepEqual(parser.extractCertifications('AWS Cloud Practitioner\nAzure Fundamentals'),
    ['AWS Cloud Practitioner', 'Azure Fundamentals']);
});

test('resume classifier accepts substantive student resumes and rejects non-resume text', () => {
  assert.equal(validity.inspectResume(textResume, parser.parse(textResume)).valid, true);
  const assignment = 'Java - Experiment 13\nClass Main\nimport java.sql.*;\npublic static void main(String[] args) { }';
  assert.equal(validity.inspectResume(assignment, parser.parse(assignment)).valid, false);
  assert.throws(() => validity.validateResume(assignment, parser.parse(assignment)), validity.NotAResumeError);
  const fakeHeadings = 'Project Report\nSkills\nGreat writing\nEducation\nUnrelated paragraphs\nProjects\nReport Overview';
  assert.equal(validity.inspectResume(fakeHeadings, parser.parse(fakeHeadings)).valid, false);
});

test('uploaded PDF buffer must begin with a valid PDF header, not just claim a PDF MIME type', () => {
  assert.throws(() => pdf.validateFile({ mimetype: 'application/pdf', size: 7, buffer: Buffer.from('not PDF') }), pdf.UnreadableResumeError);
  assert.throws(() => pdf.validateFile({ mimetype: 'image/png', size: 8, buffer: Buffer.from('%PDF-1.4') }), pdf.UnreadableResumeError);
  assert.doesNotThrow(() => pdf.validateFile({ mimetype: 'application/pdf', size: 16, buffer: Buffer.from('%PDF-1.4\nvalid') }));
});

test('non-resume uploads stop before analysis and database creation, returning a clear 422', async t => {
  const doc = 'Java Experiment 13\nDatabase Connection\nselect * from employee';
  t.mock.method(pdf, 'extractText', async () => ({ text: doc, pageCount: 1 }));
  const analysis = t.mock.method(ai, 'analyseResume', async () => { throw new Error('must not call AI'); });
  const create = t.mock.method(Resume, 'create', async () => { throw new Error('must not write DB'); });
  const res = response();
  await controller.uploadResume(request, res);
  assert.equal(res.statusCode, 422);
  assert.equal(res.body.errorCode, 'not-a-resume');
  assert.equal(analysis.mock.callCount(), 0);
  assert.equal(create.mock.callCount(), 0);
});

test('production rejects weak JWT secrets and predictable seeded demo credentials', () => {
  assert.throws(() => validateSecurityEnvironment({ NODE_ENV: 'production', JWT_SECRET: 'demo-only-secret-change-in-integration' }), /JWT_SECRET/);
  assert.throws(() => validateSecurityEnvironment({ NODE_ENV: 'production', JWT_SECRET: 'x'.repeat(32), SEED_DEMO_USER: '1', DEMO_USER_PASSWORD: 'demo1234' }), /DEMO_USER_PASSWORD/);
  assert.doesNotThrow(() => validateSecurityEnvironment({ NODE_ENV: 'production', JWT_SECRET: 'x'.repeat(40) }));
});

test('UI clears required skills when a target role changes; previous saved results remain available', () => {
  const app = fs.readFileSync(path.resolve(__dirname, '../public/js/app.js'), 'utf8');
  assert.match(app, /function clearSkillsOnRoleChange\(/);
  assert.match(app, /state\.requiredSkillset = \[\]/);
  assert.match(app, /roleInput\.addEventListener\('input', \(\) => \{\s*clearSkillsOnRoleChange\(\)/);
  assert.match(app, /roleInput\.value = value;\s*clearSkillsOnRoleChange\(\)/);
  assert.match(app, /renderSelectedSkills\(\)/);
  assert.match(app, /Current results keep their submitted context/);
  assert.match(app, /errorCode === 'not-a-resume'/);
});


test('authentication endpoints throttle repeated attempts without touching their handlers', () => {
  const { limitAuthRequests } = require('../src/middleware/authRateLimiter');
  let reached = 0;
  const makeResponse = () => ({ headers: {}, statusCode: 200, setHeader(key, value) { this.headers[key] = value; }, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } });
  for (let index = 0; index < 25; index += 1) {
    const response = makeResponse();
    limitAuthRequests({ path: '/login', ip: 'unit-test-login-client' }, response, () => { reached += 1; });
    assert.equal(response.statusCode, 200);
  }
  const blocked = makeResponse();
  limitAuthRequests({ path: '/login', ip: 'unit-test-login-client' }, blocked, () => { reached += 1; });
  assert.equal(reached, 25);
  assert.equal(blocked.statusCode, 429);
  assert.ok(Number(blocked.headers['Retry-After']) > 0);
});

test('HTTP server sends basic hardening headers and does not allow arbitrary cross-origin browser access', async () => {
  const app = require('../server');
  const httpServer = app.listen(0, '127.0.0.1');
  await new Promise(resolve => httpServer.once('listening', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${httpServer.address().port}/api/auth/me`, {
      headers: { Origin: 'https://untrusted.invalid' },
    });
    assert.equal(response.status, 401);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(response.headers.get('x-frame-options'), 'DENY');
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('access-control-allow-origin'), null);
    assert.equal(response.headers.get('x-powered-by'), null);
  } finally {
    await new Promise(resolve => httpServer.close(resolve));
  }
});


test('instant authenticated PDF preflight accepts resume, rejects assignment, and never runs AI', async t => {
  const app = require('../server');
  const auth = require('../src/services/authService');
  const analyse = t.mock.method(ai, 'analyseResume', async () => { throw new Error('preflight must not call AI'); });
  const create = t.mock.method(Resume, 'create', async () => { throw new Error('preflight must not create resume'); });
  const httpServer = app.listen(0, '127.0.0.1');
  await new Promise(resolve => httpServer.once('listening', resolve));
  const token = auth.generateToken({ id: '000000000000000000000001', name: 'Test User', email: 'test@example.com' });
  const api = `http://127.0.0.1:${httpServer.address().port}/api/resume/validate`;
  async function verify(file) {
    const form = new FormData();
    form.append('resume', new Blob([fs.readFileSync(path.join(__dirname, file))], { type: 'application/pdf' }), 'candidate.pdf');
    const res = await fetch(api, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form });
    return { status: res.status, body: await res.json() };
  }
  try {
    const valid = await verify('sample_resume.pdf');
    assert.equal(valid.status, 200);
    assert.deepEqual(Object.keys(valid.body).sort(), ['pageCount', 'valid']);
    const invalid = await verify('fixtures/non-resume-assignment.pdf');
    assert.equal(invalid.status, 422);
    assert.equal(invalid.body.errorCode, 'not-a-resume');
    assert.equal(analyse.mock.callCount(), 0);
    assert.equal(create.mock.callCount(), 0);
  } finally {
    await new Promise(resolve => httpServer.close(resolve));
  }
});
