const test = require('node:test');
const assert = require('node:assert/strict');
const { summarize, main, parseEvaluationArgs } = require('./evaluateQuestions');

test('summary counts distinct text, types and concrete anchors without treating role topics as resume evidence', () => {
  const context = {
    skills: ['C++', 'MongoDB'], projects: [{ title: 'Nexus', description: '', technologies: [] }],
    experience: [], education: [], targetRole: 'Backend Developer',
  };
  const result = { questions: [
    { question: 'How would you test it?', type: 'technical', basedOn: 'Nexus - MongoDB' },
    { question: ' HOW   WOULD YOU TEST IT!!! ', type: 'technical', basedOn: 'REST API Design' },
    { question: 'Which approach would you choose?', type: 'technical', basedOn: 'C++' },
    { question: 'How did you collaborate?', type: 'behavioral', basedOn: 'general' },
    { question: 'How would you debug it?', type: 'technical', basedOn: 'NexusClone' },
  ] };
  assert.deepEqual(summarize(result, context), {
    total: 5, distinct: 4, grounded: 2,
    counts: { technical: 4, project: 0, experience: 0, behavioral: 1 },
  });
});

test('summary handles an extracted resume with empty sections', () => {
  assert.equal(summarize({ questions: [{ question: 'How would you start?', type: 'technical', basedOn: 'Software Design' }] },
    { skills: [], projects: [], experience: [], education: [] }).grounded, 0);
});

test('missing CLI path prints usage and fails without invoking the pipeline', async (t) => {
  const oldCode = process.exitCode;
  t.after(() => { process.exitCode = oldCode; });
  const error = t.mock.method(console, 'error', () => {});
  await main([]);
  assert.equal(process.exitCode, 1);
  assert.match(error.mock.calls[0].arguments[0], /Usage:/);
});

test('CLI selection preserves four-role default and accepts one supported role', () => {
  assert.deepEqual(parseEvaluationArgs(['resume.pdf']), {
    pdfPath: 'resume.pdf', roles: ['Backend Developer', 'Full Stack Developer', 'C++ Developer', 'QA Engineer'],
  });
  assert.deepEqual(parseEvaluationArgs(['resume.pdf', '--role', 'backend developer']), {
    pdfPath: 'resume.pdf', roles: ['Backend Developer'],
  });
  for (const args of [[], ['resume.pdf', '--role'], ['resume.pdf', '--unknown', 'QA Engineer']]) {
    assert.throws(() => parseEvaluationArgs(args), /Usage:/);
  }
  assert.throws(() => parseEvaluationArgs(['resume.pdf', '--role', 'private unsupported role']),
    (error) => error.message.startsWith('Unsupported role.') && !error.message.includes('private'));
});

test('invalid CLI role fails cleanly before any PDF or service access', async (t) => {
  const fs = require('node:fs/promises');
  const oldCode = process.exitCode;
  t.after(() => { process.exitCode = oldCode; });
  t.mock.method(fs, 'stat', () => { throw new Error('Must not read files'); });
  const log = t.mock.method(console, 'error', () => {});
  await main(['resume.pdf', '--role', 'Unknown Role']);
  assert.equal(process.exitCode, 1);
  assert.match(log.mock.calls[0].arguments[0], /^Unsupported role\./);
});

test('service-layer evaluation generates only the selected role or all four by default without network calls', async (t) => {
  const fs = require('node:fs/promises');
  const pdf = require('../src/services/pdfService');
  const ollama = require('../src/services/ollamaService');
  const axios = require('axios');
  t.mock.method(fs, 'stat', async () => ({ isFile: () => true, size: 10 }));
  t.mock.method(fs, 'readFile', async () => Buffer.from('mocked input'));
  t.mock.method(pdf, 'extractText', async () => ({ text: 'Skills\nNode.js, MongoDB', pageCount: 1 }));
  const analyse = t.mock.method(ollama, 'analyseResume', async () => ({
    summary: '', strengths: [], skillAreasToProbe: [], source: 'heuristic-fallback',
  }));
  const post = t.mock.method(axios, 'post', async () => { throw new Error('mocked offline'); });
  const log = t.mock.method(console, 'log', () => {});
  for (const [args, roles] of [
    [['resume.pdf', '--role', 'Backend Developer'], ['Backend Developer']],
    [['resume.pdf'], ['Backend Developer', 'Full Stack Developer', 'C++ Developer', 'QA Engineer']],
  ]) {
    log.mock.resetCalls();
    const before = post.mock.callCount();
    await main(args);
    const headers = log.mock.calls.map((call) => call.arguments[0]).filter((line) => line.includes('\nROLE:'));
    assert.equal(headers.length, roles.length);
    roles.forEach((role, i) => assert.ok(headers[i].includes(`ROLE: ${role}\n`)));
    assert.equal(post.mock.callCount() - before, roles.length);
  }
  assert.equal(analyse.mock.callCount(), 2); // Once per evaluation, not once per role.
});
