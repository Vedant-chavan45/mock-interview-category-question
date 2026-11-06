'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { registerProvider } = require('../src/ai/modelGateway');
const { generateCategoryQuestions } = require('../src/services/questionGeneratorService');

const context = {
  targetRole: 'Software Intern', interviewType: 'Technical',
  requiredSkillset: ['Problem Solving', 'OOP', 'DSA', 'DBMS', 'REST API', 'Git'],
  projects: [{ title: 'Parking Scheduler', description: 'Java Swing UI with JDBC and MySQL parking records.', technologies: ['Java', 'JDBC', 'MySQL']}],
};
const input = [
  'How would you explain where input validation belongs when a form sends data through an API?',
  'What does it mean to keep related customer and order records consistent in a database?',
  'Why is hiding a button insufficient to authorize an API operation for a user?',
  'How would you test a new endpoint using valid, missing, and malformed inputs?',
  'What data structure would you choose to detect duplicate IDs and what is its time complexity?',
  'How would you implement, test, and submit a small change through a Git pull request?',
];
const changed = 'What tests would you write for a login endpoint that rejects invalid input with appropriate status codes?';

// Fake provider returns valid JSON and timing metadata and never makes a
// network call; this exercises actual generation, independent review,
// preservation of accepted slots, repair, re-review and telemetry plumbing.
test('optional semantic reviewer repairs only rejected slot and revalidates all six', async () => {
  const previousFlag = process.env.AI_INTERVIEW_REVIEW_ENABLED;
  const previousProvider = process.env.AI_PROVIDER;
  process.env.AI_PROVIDER = 'ollama';
  process.env.AI_INTERVIEW_REVIEW_ENABLED = '1';
  const stages = [];
  registerProvider('ollama', {
    async generateStructured(request) {
      stages.push(request.stage);
      request.onFirstChunk?.();
      let body;
      if (request.stage === 'quality-review') {
        body = {issues: stages.filter((stage) => stage === 'quality-review').length === 1
          ? [{questionIndex: 3, code: 'generic_or_shallow'}] : []};
      } else if (request.stage === 'quality-repair') {
        body = {questions: [changed]};
      } else {
        body = {questions: input};
      }
      return {response: JSON.stringify(body), status: 200, done: true, doneReason: 'stop',
        evalCount: 120, promptEvalCount: 500, totalDuration: 2e9, evalDuration: 1e9,
        promptEvalDuration: 0.5e9, loadDuration: 0};
    },
  });
  try {
    const result = await generateCategoryQuestions(context, 'domain_fundamentals',
      {force: true, crossCategoryQuestions: ['An endpoint slowed under load, what would you check first?']});
    assert.equal(result.status, 'ready');
    assert.equal(result.questions.length, 6);
    assert.equal(result.questions[3].question, changed);
    for (let i=0;i<6;i++) if (i!==3) assert.equal(result.questions[i].question, input[i]);
    assert.deepEqual(stages, ['generation', 'quality-review', 'quality-repair', 'quality-review']);
    assert.equal(result.metrics.repairCount, 1);
    assert.equal(result.metrics.qualityReviewCalls, 2);
    assert.ok(result.metrics.totalDurationMs >= 0);
  } finally {
    if (previousFlag === undefined) delete process.env.AI_INTERVIEW_REVIEW_ENABLED;
    else process.env.AI_INTERVIEW_REVIEW_ENABLED = previousFlag;
    if (previousProvider === undefined) delete process.env.AI_PROVIDER;
    else process.env.AI_PROVIDER = previousProvider;
  }
});
