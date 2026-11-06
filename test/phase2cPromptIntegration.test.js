'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
// This test only inspects prompt composition; no npm dependency, inference,
// network, authentication or real resume is needed.
const originalLoad = Module._load;
let generator;
try {
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'axios') return {post: async () => { throw new Error('network prohibited in integration prompt test'); }};
    return originalLoad.call(this, request, parent, isMain);
  };
  generator = require('../src/services/questionGeneratorService');
} finally {
  Module._load = originalLoad;
}

const context = {
  targetRole: 'Software Intern', interviewType: 'Technical',
  requiredSkillset: ['Problem Solving', 'OOP', 'DSA', 'DBMS', 'REST API', 'Git'],
  projects: [
    {title:'Parking Scheduler', description:'Java Swing app implementing parking slot reservations with JDBC and MySQL.', technologies:['Java','JDBC','MySQL']},
    {title:'Language Assistant', description:'Translation client that sends requests to a REST API and displays translated text.', technologies:['JavaScript','REST API']},
  ],
  experience: [{role:'Developer Intern', organisation:'Example Lab', responsibilities:['Implemented Python data-cleaning scripts processing CSV exports.']}],
};

test('fundamentals prompt evaluates software engineering skills, not six debugging incidents', () => {
  const prompt = generator.buildCategoryQuestionPrompt(context, 'domain_fundamentals');
  assert.match(prompt, /Explain a practical test strategy/);
  assert.match(prompt, /choosing a basic algorithm or data structure/);
  assert.match(prompt, /Git/);
  assert.match(prompt, /Do NOT personalize by pasting a project/);
  assert.doesNotMatch(prompt, /mentionProjectNameOnce/);
});

test('project prompt contains grounded functionality, not mandatory project name insertion', () => {
  const prompt = generator.buildCategoryQuestionPrompt(context, 'project_deep_dive');
  assert.match(prompt, /parking slot reservations/);
  assert.match(prompt, /JDBC/);
  assert.match(prompt, /mustAskNotAssume/);
  assert.doesNotMatch(prompt, /must mention each actual project name once/i);
  assert.match(prompt, /ASK how it works/);
});

test('experience prompt keeps actual responsibilities separate from imagined events', () => {
  const prompt = generator.buildCategoryQuestionPrompt(context, 'professional_experience');
  assert.match(prompt, /Python data-cleaning scripts/);
  assert.match(prompt, /do not assert that it exists/);
  assert.match(prompt, /documentedResponsibility|documented responsibilities/);
});

test('applied and behavioral prompts explicitly prohibit vague project-name swapping and assumed disputes', () => {
  const applied = generator.buildCategoryQuestionPrompt(context, 'applied_scenarios');
  const behavioral = generator.buildCategoryQuestionPrompt(context, 'behavioral_collaboration');
  assert.match(applied, /observable technical clue/);
  assert.match(applied, /meaningful constraint/);
  assert.match(behavioral, /without assuming incidents|without assuming a formal team|never invent a past event/);
  assert.match(behavioral, /avoid inventing a real dispute/);
});

test('prompt uses previous questions from other categories to avoid the same competency', () => {
  const prompt = generator.buildCategoryQuestionPrompt(context, 'applied_scenarios', undefined, undefined, {
    generationIndex: 0,
    previousQuestions: ['How would you investigate an API that suddenly slows down during busy hours?'],
    crossCategoryQuestions: ['How would you investigate an API that suddenly slows down during busy hours?'],
  });
  assert.match(prompt, /PREVIOUSLY ASKED QUESTIONS/);
  assert.match(prompt, /OTHER.*QUESTIONS|otherCategoryQuestionsToAvoid/);
  assert.match(prompt, /suddenly slows down during busy hours/);
});
