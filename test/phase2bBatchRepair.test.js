'use strict';

// Standalone regression tests: no API key, database, network or node_modules.
// Only the axios transport is mocked; real generation, planning, validation,
// provider gateway, and Groq response parsing are exercised.
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

const transport = { post: async () => { throw new Error('Unexpected network request'); }, isAxiosError: () => false };
const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === 'axios') return transport;
  return originalLoad.call(this, request, parent, isMain);
};
let generator;
let contextBuilder;
let telemetry;
try {
  generator = require('../src/services/questionGeneratorService');
  contextBuilder = require('../src/services/contextBuilder');
  telemetry = require('../src/ai/telemetry');
} finally {
  Module._load = originalLoad;
}
const { parsedResume, analysis, targetRole, interviewType } = require('./fixtures/syntheticInterviewResume');
const { collectCompactTechnicalIssues } = require('../src/ai/quality/compactTechnicalGate');

function fixture() {
  return contextBuilder.build(parsedResume, analysis, {
    interviewType, targetRole, requiredSkillset: ['Node.js', 'Express', 'MongoDB'],
  });
}
const acceptedItems = [
  { topic: 'event loop', question: 'How does the event loop manage callbacks while Node.js processes nonblocking requests?' },
  { topic: 'Express middleware', question: 'What happens when Express middleware calls next twice during one incoming HTTP request?' },
  { topic: 'MongoDB index', question: 'How would a MongoDB index change an explain plan for a filtered collection query?' },
  { topic: 'JavaScript closures', question: 'Why can JavaScript closures retain variables after the outer function has returned?' },
  { topic: 'HTTP caching', question: 'How does HTTP caching reduce repeated requests without returning stale application data?' },
  { topic: 'database transaction', question: 'When should a database transaction roll back an update across related records?' },
];

function groqReply(items) {
  return { status: 200, data: {
    choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ items }) } }],
    usage: { prompt_tokens: 300, completion_tokens: 100 },
  } };
}
function setEnv(t) {
  const values = {
    AI_PROVIDER: 'groq', GROQ_API_KEY: 'unit-test-not-a-real-key',
    GROQ_MODEL: 'openai/gpt-oss-120b', GROQ_RESPONSE_FORMAT: 'json_schema',
    QUESTION_GENERATION_MODE: 'compact', DEBUG_QUESTION_GENERATION: '0',
    AI_PERF_LOG_ENABLED: '0',
  };
  const old = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  Object.assign(process.env, values);
  t.after(() => {
    for (const [key, value] of Object.entries(old)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    transport.post = async () => { throw new Error('Unexpected network request'); };
  });
}

test('two rejected quality slots are repaired together, while four accepted questions remain unchanged', async (t) => {
  setEnv(t);
  const original = acceptedItems.map((item) => ({ ...item }));
  original[2].topic = 'nonexistent topic label';
  original[4].topic = 'another nonexistent label';
  let calls = 0;
  let repairPrompt;
  transport.post = async (_url, body) => {
    calls++;
    if (calls === 1) return groqReply(original);
    assert.equal(calls, 2, 'Only one grouped repair call should be necessary');
    repairPrompt = body.messages[0].content;
    assert.match(repairPrompt, /REJECTED_SLOTS/);
    assert.equal(body.response_format.json_schema.schema.properties.items.minItems, 2);
    assert.equal(body.response_format.json_schema.schema.properties.items.maxItems, 2);
    return groqReply([acceptedItems[2], acceptedItems[4]]);
  };
  const result = await generator.generateCategoryQuestions(fixture(), 'technical_concepts', { force: true });
  assert.equal(result.status, 'ready');
  assert.equal(result.source, 'groq-openai/gpt-oss-120b');
  assert.equal(result.questions.length, 6);
  assert.equal(result.metrics.repairCount, 1);
  assert.equal(calls, 2);
  assert.deepEqual(result.questions.map((item) => item.question), acceptedItems.map((item) => item.question));
  assert.match(repairPrompt, /nonexistent topic label/);
  assert.match(repairPrompt, /another nonexistent label/);
});

test('even after bounded repair rounds, invalid questions are rejected rather than silently accepted', async (t) => {
  setEnv(t);
  const initial = acceptedItems.map((item) => ({ ...item }));
  initial[2].topic = 'not in question';
  initial[4].topic = 'not in question either';
  let calls = 0;
  transport.post = async (_url, body) => {
    calls++;
    if (calls === 1) return groqReply(initial);
    const count = body.response_format.json_schema.schema.properties.items.minItems;
    return groqReply(Array.from({ length: count }, (_, index) => ({
      question: acceptedItems[index === 0 ? 2 : 4].question,
      topic: 'still not in question',
    })));
  };
  const err = await generator.generateCategoryQuestions(fixture(), 'technical_concepts', { force: true })
    .catch((error) => error);
  assert.equal(err.code, 'QUESTION_QUALITY_REJECTED');
  assert.ok(calls <= 3, 'One initial call plus at most two repair rounds');
  assert.equal(telemetry.failureCategory(err), 'quality_rejected');
});

test('quality issue collector reports independent bad slots in one pass', () => {
  const slots = acceptedItems.map((item, index) => ({
    slotId: `technical_${index + 1}`, subtopic: item.topic, keyTerms: [item.topic],
    primaryAssessmentTarget: ['Node.js', 'Express', 'MongoDB', 'Node.js', 'Express', 'MongoDB'][index],
    primaryRequiredSkill: ['Node.js', 'Express', 'MongoDB', 'Node.js', 'Express', 'MongoDB'][index],
    skillKind: 'core_concept',
  }));
  const items = acceptedItems.map((item) => ({ ...item }));
  items[2].topic = 'not really present';
  items[4].topic = 'not here either';
  const issues = collectCompactTechnicalIssues(items, { slots, skillClassifications: [] }, {
    skills: ['Node.js', 'Express', 'MongoDB'],
  });
  assert.deepEqual(issues.filter((issue) => issue.code === 'unverifiable-topic-label').map((issue) => issue.questionIndex), [2, 4]);
});
