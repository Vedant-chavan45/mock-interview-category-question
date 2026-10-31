const test = require('node:test');
const assert = require('node:assert/strict');
const parser = require('../src/services/resumeParserService');
const { buildInterviewPlan, rankFocusEvidence } = require('../src/services/interviewPlannerService');
const { heuristicFallbackQuestions } = require('../src/services/questionGeneratorService');

const resume = [
  'Skills', 'Python, JavaScript, C++, OOP, Data Structures and Algorithms, Operating Systems, Node.js, MongoDB',
  'Experience', 'Full Stack Developer Intern01/2024 – 06/2024', 'Elastik TeamsRemote',
  '- Developed an employee allocation system using MySQL.',
  'and integrated REST APIs across layers.',
  '- Debugged backend issues.',
  'Projects',
  'AI-Powered Mock Interview Platform| Node.js, Express.js, MongoDB, Mongoose, Ollama, Llama 3.2',
  '- Built JWT authentication and bcrypt password security.',
  '- Integrated a resume-processing pipeline with Ollama.',
  'and a heuristic fallback when the service is unavailable.',
  'Nexus — Full Stack Social Platform| Node.js, Express.js, React.js, MongoDB, Socket.IO',
  '- Built 13 REST API endpoints and real-time messaging.',
  '- Implemented protected React routes and MongoDB search.',
  'Education', 'B.Tech - Example University', '2020 - 2024',
].join('\n');

test('two project headings split after bullets and retain full titles, stacks and isolated descriptions', () => {
  const { projects } = parser.parse(resume);
  assert.equal(projects.length, 2);
  assert.equal(projects[0].title, 'AI-Powered Mock Interview Platform');
  assert.equal(projects[1].title, 'Nexus — Full Stack Social Platform');
  assert.deepEqual(projects[0].technologies, ['Node.js', 'Express.js', 'MongoDB', 'Mongoose', 'Ollama', 'Llama 3.2']);
  assert.deepEqual(projects[1].technologies, ['Node.js', 'Express.js', 'React.js', 'MongoDB', 'Socket.IO']);
  assert.doesNotMatch(projects[0].description, /Nexus|13 REST|protected React/);
  assert.match(projects[0].description, /and a heuristic fallback/);
  assert.match(projects[1].description, /13 REST API endpoints/);
  assert.doesNotMatch(projects[1].description, /bcrypt|resume-processing/);
});

test('simpler project formats and wrapped bullet descriptions remain supported', () => {
  for (const heading of ['Task Tracker | Node.js, MongoDB', 'Task Tracker - Node.js, MongoDB',
    'Task Tracker\nTech: Node.js, MongoDB']) {
    const projects = parser.extractProjects(`${heading}\n- Built APIs\nand added validation.\n- Tested edge cases.`);
    assert.equal(projects.length, 1);
    assert.equal(projects[0].title, 'Task Tracker');
    assert.deepEqual(projects[0].technologies, ['Node.js', 'MongoDB']);
    assert.match(projects[0].description, /Built APIs and added validation/);
  }
  const projects = parser.extractProjects('Task Tracker\n- Built an API.\nWeather Dashboard\n- Displayed forecasts.');
  assert.deepEqual(projects.map((p) => p.title), ['Task Tracker', 'Weather Dashboard']);
});

test('heading detection also splits pipe/stack headings before any bullet descriptions', () => {
  const projects = parser.extractProjects('First App | Node.js\nBuilt an API.\nSecond App | React.js\nBuilt a UI.');
  assert.equal(projects.length, 2);
  assert.deepEqual(projects[1].technologies, ['React.js']);
});

test('experience keeps role and organisation separate from location and date metadata', () => {
  for (const organisation of ['Elastik TeamsRemote', 'Elastik Teams\nRemote',
    'Elastik Teams\nPune, India', 'Elastik Teams\nMumbai', 'Elastik Teams | Pune, India']) {
    const [entry] = parser.extractExperience(`Full Stack Developer Intern01/2024 – 06/2024\n${organisation}\n- Built APIs.`);
    assert.equal(entry.role, 'Full Stack Developer Intern');
    assert.equal(entry.organisation, 'Elastik Teams');
    assert.equal(entry.duration, '01/2024 - 06/2024');
    assert.deepEqual(entry.responsibilities, ['Built APIs.']);
  }
  for (const organisation of ['Remote Labs', 'RemoteWorks', 'Mumbai Technologies', 'Pune Systems']) {
    const [entry] = parser.extractExperience(`Developer\n${organisation}\n- Built APIs.`);
    assert.equal(entry.organisation, organisation);
  }
});

test('memory focus rejects business allocation and retains memory-specific evidence', () => {
  const memory = (claim) => buildInterviewPlan({ targetRole: 'C++ Developer',
    experience: [{ role: 'Intern', responsibilities: [claim] }] })
    .focusAreas.find((a) => a.topic === 'Memory Management & Pointers').evidence;
  for (const claim of ['employee allocation', 'resource allocation', 'project allocation', 'allocation']) {
    assert.deepEqual(memory(claim), []);
  }
  for (const claim of ['memory allocation', 'dynamic allocation', 'heap allocation', 'malloc',
    'free', 'free()', 'new/delete', 'pointers', 'references', 'RAII', 'memory management']) {
    assert.ok(memory(claim).includes(claim), claim);
  }
});

test('systems fundamentals rank OOP/C++ before other languages and descriptive evidence', () => {
  const input = { targetRole: 'C++ Developer', skills: ['Python', 'JavaScript', 'C++', 'OOP',
    'Data Structures and Algorithms', 'Operating Systems'],
  projects: [{ title: 'Scripting App', technologies: ['Python'], description: 'Built Python programming tools.' }] };
  const result = heuristicFallbackQuestions(input);
  assert.equal(result.questions[0].basedOn, 'C++');
  assert.equal(result.questions[1].basedOn, 'OOP');
  assert.doesNotMatch(result.questions[1].question, /Python/);
  assert.equal(result.questions.length, 6);
  assert.equal(new Set(result.questions.map((q) => q.question)).size, 6);
  assert.deepEqual(result, heuristicFallbackQuestions(input));
  assert.deepEqual(rankFocusEvidence('Programming Fundamentals & OOP', ['Python', 'C++'], 'systems'), ['C++', 'Python']);
  assert.equal(heuristicFallbackQuestions({ targetRole: 'C++ Developer', skills: ['Python', 'C++'] })
    .questions[1].basedOn, 'C++');
  assert.equal(rankFocusEvidence('Debugging & Root-Cause Analysis',
    ['Intern', 'Investigated and resolved backend issues with database queries.'], 'qa')[0],
  'Investigated and resolved backend issues with database queries.');
});

test('backend evidence selection still prefers APIs/Node over unrelated leading skills', () => {
  const result = heuristicFallbackQuestions({ targetRole: 'Backend Developer',
    skills: ['Python', 'C++', 'Node.js', 'MongoDB', 'JWT'] });
  assert.equal(result.questions[0].basedOn, 'Node.js');
  assert.match(result.questions[0].question, /REST API Design/);
});

test('separated projects flow into distinct project questions without business-allocation memory evidence', () => {
  const parsed = parser.parse(resume);
  const context = { ...parsed, targetRole: 'C++ Developer' };
  const memory = buildInterviewPlan(context).focusAreas.find((a) => a.topic === 'Memory Management & Pointers');
  assert.deepEqual(memory.evidence, []);
  assert.deepEqual(heuristicFallbackQuestions(context).questions.filter((q) => q.type === 'project').map((q) => q.basedOn),
    parsed.projects.map((p) => p.title));
});
