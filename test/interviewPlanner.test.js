const test = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');
const { buildInterviewPlan } = require('../src/services/interviewPlannerService');
const { buildQuestionPrompt, heuristicFallbackQuestions, generateQuestions } = require('../src/services/questionGeneratorService');

const resume = {
  skills: ['C++', 'Python', 'HTML', 'CSS', 'Node.js', 'Express', 'REST APIs', 'MongoDB', 'JWT',
    'OOP', 'DSA', 'OS', 'STL', 'pointers', 'concurrency'],
  projects: [
    { title: 'Portfolio', technologies: ['HTML', 'CSS'], description: 'Built a personal website.' },
    { title: 'Nexus', technologies: ['Node.js', 'Express', 'MongoDB'], description: 'Built REST APIs with JWT authentication.' },
    { title: 'Scheduler', technologies: ['C++'], description: 'Used STL and pointers with concurrency.' },
  ],
  experience: [{ role: 'Backend Intern', responsibilities: ['Debugged database issues.'] }],
  education: [{ degree: 'Computer Science' }],
};

const cases = [
  ['Backend Developer', 'backend'], ['Senior BACK-END Engineer', 'backend'],
  ['Node.js Developer', 'backend'], ['server-side developer', 'backend'],
  ['C++ Developer', 'systems'], ['Senior CPP Engineer', 'systems'], ['Embedded Engineer', 'systems'],
  ['QA Engineer', 'qa'], ['Quality Assurance Engineer', 'qa'], ['SDET', 'qa'], ['Automation Engineer', 'qa'],
  ['Full Stack Developer', 'fullstack'], ['FULL-STACK Engineer', 'fullstack'], ['Fullstack Developer', 'fullstack'],
  ['React Developer', 'frontend'], ['UI Developer', 'frontend'], ['Front-end Engineer', 'frontend'],
  ['Data Analyst', 'data'], ['Database Engineer', 'data'], ['SQL Developer', 'data'],
  ['ML Engineer', 'ai-ml'], ['Data Scientist', 'ai-ml'], ['Machine Learning Engineer', 'ai-ml'],
  ['Astronaut', 'generic'], ['', 'generic'],
];

test('role matching supports all families and common case/wording variations', () => {
  for (const [targetRole, profile] of cases) {
    assert.equal(buildInterviewPlan({ targetRole }).roleProfile, profile, targetRole);
  }
});

test('same resume produces different supported backend and systems priorities', () => {
  const backend = buildInterviewPlan({ ...resume, targetRole: 'Backend Developer' });
  const systems = buildInterviewPlan({ ...resume, targetRole: 'C++ Developer' });
  assert.equal(backend.primaryDomain, 'Backend Engineering');
  assert.equal(systems.primaryDomain, 'C++ / Systems Engineering');
  assert.notDeepEqual(backend.focusAreas, systems.focusAreas);
  assert.equal(backend.focusAreas[0].topic, 'REST API Design');
  assert.equal(systems.focusAreas[0].topic, 'C++');
  const api = backend.focusAreas[0];
  for (const evidence of ['Node.js', 'Express', 'REST APIs', 'Nexus']) assert.ok(api.evidence.includes(evidence));
  assert.equal(api.priority, 'high');
  assert.ok(backend.focusAreas.find((a) => a.topic.includes('Databases')).evidence.includes('MongoDB'));
  assert.ok(backend.focusAreas.find((a) => a.topic.includes('Security')).evidence.includes('JWT'));
  for (const evidence of ['C++', 'OOP', 'DSA', 'OS', 'STL', 'pointers', 'concurrency']) {
    assert.ok(systems.focusAreas.some((a) => a.evidence.includes(evidence)), evidence);
  }
  assert.ok(!api.evidence.includes('HTML'));
});

test('evidence is taken only from structured claims, never role or analysis assumptions', () => {
  const input = { targetRole: 'Backend Developer', skills: ['HTML'],
    candidateSummary: 'Expert in MongoDB', strengths: ['JWT'], skillAreasToProbe: ['Express'] };
  assert.ok(buildInterviewPlan(input).focusAreas.every((a) => a.evidence.length === 0));
  const allowed = new Set([...resume.skills, ...resume.projects.flatMap((p) => [p.title, p.description, ...p.technologies]),
    ...resume.experience.flatMap((e) => [e.role, ...e.responsibilities]), 'Computer Science']);
  for (const a of buildInterviewPlan({ ...resume, targetRole: 'Backend Developer' }).focusAreas) {
    for (const value of a.evidence) assert.ok(allowed.has(value), value);
  }
  const isolated = buildInterviewPlan({ targetRole: 'C++ Developer', skills: ['CSS', 'NoSQL', 'sculpture'] });
  assert.ok(isolated.focusAreas.every((a) => !a.evidence.length));
});

test('interview type modifies emphasis without losing the role domain', () => {
  const technical = buildInterviewPlan({ ...resume, targetRole: 'Backend Developer' });
  const mixed = buildInterviewPlan({ ...resume, targetRole: 'Backend Developer', interviewType: 'Mixed' });
  const hr = buildInterviewPlan({ ...resume, targetRole: 'Backend Developer', interviewType: 'HR' });
  assert.match(technical.emphasis, /technical domain depth/);
  assert.match(mixed.emphasis, /project and experience breadth/);
  assert.equal(hr.primaryDomain, technical.primaryDomain);
  assert.match(hr.focusAreas[0].topic, /Communication/);
  assert.equal(hr.focusAreas[0].priority, 'high');
  assert.ok(hr.focusAreas.slice(1).every((a) => a.priority === 'medium'));
});

test('minimal, legacy and malformed contexts are deterministic and safe without mutation', () => {
  for (const input of [undefined, null, 42, {}, { experienceSummary: 'Engineer at Old Co' },
    { targetRole: {}, interviewType: [], skills: [null, {}, 1], projects: [null, { technologies: 3 }],
      experience: [null, { responsibilities: 'bad' }], education: [null] }]) {
    const before = JSON.stringify(input);
    const plan = buildInterviewPlan(input);
    assert.deepEqual(plan, buildInterviewPlan(input));
    assert.equal(JSON.stringify(input), before);
    const result = heuristicFallbackQuestions(input);
    assert.equal(result.questions.length, 6);
    assert.equal(new Set(result.questions.map((q) => q.question)).size, 6);
  }
});

test('prompt includes compact generated blueprint and protects unsupported fundamentals', () => {
  const input = { ...resume, targetRole: 'Backend Developer' };
  const plan = buildInterviewPlan(input);
  const prompt = buildQuestionPrompt(input, plan);
  assert.match(prompt, /PLAN/);
  assert.match(prompt, /Backend Engineering/);
  for (const area of plan.focusAreas.slice(0, 5)) {
    assert.ok(prompt.includes(area.topic));
    if (area.evidence.length) assert.match(prompt, /RESUME/);
  }
  assert.match(prompt, /without claiming candidate experience not shown/);
  assert.match(prompt, /concrete resume facts/);
  assert.match(prompt, /Required slot types in this exact order/);
  assert.equal(prompt, buildQuestionPrompt(input));
});

test('fallback technical questions prefer role evidence over leading skills and projects', () => {
  const backend = heuristicFallbackQuestions({ ...resume, targetRole: 'Backend Developer' });
  const systems = heuristicFallbackQuestions({ ...resume, targetRole: 'C++ Developer' });
  for (const result of [backend, systems]) {
    assert.equal(result.questions.length, 6);
    assert.equal(new Set(result.questions.map((q) => q.question)).size, 6);
    for (const q of result.questions) assert.deepEqual(Object.keys(q).sort(), ['basedOn', 'question', 'type']);
  }
  assert.equal(backend.questions[0].basedOn, 'Nexus');
  assert.match(backend.questions[0].question, /REST API Design/);
  assert.equal(systems.questions[0].basedOn, 'Scheduler');
  assert.match(systems.questions[0].question, /C\+\+/);
  const skillsOnly = heuristicFallbackQuestions({ skills: resume.skills, targetRole: 'Backend Developer' });
  assert.equal(skillsOnly.questions[0].basedOn, 'Node.js');
  assert.ok(!skillsOnly.questions.slice(0, 2).some((q) => ['C++', 'Python', 'HTML', 'CSS'].includes(q.basedOn)));
  const noEvidence = heuristicFallbackQuestions({ targetRole: 'Backend Developer' });
  assert.match(noEvidence.questions[0].question, /how would you approach REST API Design/);
  assert.doesNotMatch(noEvidence.questions[0].question, /you implemented|your resume evidence/);
});

test('public generation builds the plan on demand and retains the response contract', async (t) => {
  const input = { ...resume, targetRole: 'QA Engineer' };
  const modelQuestions = heuristicFallbackQuestions(input).questions.map(({ question }) => question);
  t.mock.method(axios, 'post', async (url, body) => {
    assert.match(body.prompt, /QA \/ Test Engineering/);
    return { status: 200, data: { response: JSON.stringify({ questions: modelQuestions }) } };
  });
  const result = await generateQuestions(input);
  assert.equal(result.source, 'ollama-llama3.2');
  assert.equal(result.questions.length, 6);
  assert.deepEqual(result.questions.map((q) => q.type), ['technical', 'technical', 'project', 'project', 'experience', 'behavioral']);
});
