'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { CATEGORY_STANDARDS, fundamentalsObjective, makeCategoryBrief } = require('../src/ai/quality/interviewStandards');
const { REVIEW_SCHEMA, reviewPrompt, parseReview, reviewedRepairPrompt } = require('../src/ai/quality/interviewReviewer');
const { getQuestionCategory } = require('../src/services/questionCategories');
const { buildCategoryBlueprint } = require('../src/services/categoryBlueprintService');

const resume = {
  targetRole: 'Software Intern', requiredSkillset: ['Problem Solving', 'OOP', 'DSA', 'DBMS', 'REST API', 'Git'],
  projects: [{ title: 'Parking Scheduler', description: 'Java Swing parking reservations with JDBC and MySQL.', technologies: ['Java', 'JDBC', 'MySQL'] }],
  experience: [{ role: 'Software Intern', organisation: 'Example Org', responsibilities: ['Wrote Python scripts for cleaning CSV records'] }],
};

test('all six category standards exist and have different assessment purposes', () => {
  for (const id of ['domain_fundamentals','technical_concepts','project_deep_dive','professional_experience','applied_scenarios','behavioral_collaboration']) {
    assert.ok(getQuestionCategory(id));
    assert.ok(CATEGORY_STANDARDS[id]?.purpose?.length > 50);
  }
  assert.equal(new Set(Object.values(CATEGORY_STANDARDS).map((rule) => rule.purpose)).size, 6);
});

test('fundamentals targets testing, algorithms and Git rather than six incident scenarios', () => {
  const generic = [0,1,2,3,4,5].map((index) => fundamentalsObjective('generic', index));
  assert.match(generic[3], /test strategy/i);
  assert.match(generic[4], /algorithm|data structure/i);
  assert.match(generic[5], /Git/i);
  assert.equal(new Set(generic).size, 6);
  assert.equal(fundamentalsObjective('qa', 0), ''); // QA retains its separate blueprint
});

test('project evidence cards carry actual functionality, not an invented implementation', () => {
  const blueprint = buildCategoryBlueprint(resume, 'project_deep_dive');
  const brief = makeCategoryBrief('project_deep_dive', blueprint);
  const card = brief.slotBriefs[0].evidence;
  assert.equal(card.documentedProjectTitle, 'Parking Scheduler');
  assert.match(card.documentedFunctionality, /JDBC and MySQL/);
  assert.deepEqual(card.documentedTechnologies, ['Java', 'JDBC', 'MySQL']);
  assert.match(card.mustAskNotAssume, /UNKNOWN/);
  assert.equal('assumedDatabaseTransactions' in card, false);
});

test('experience evidence carries only documented responsibilities', () => {
  const brief = makeCategoryBrief('professional_experience', buildCategoryBlueprint(resume, 'professional_experience'));
  assert.ok(brief.slotBriefs[0].evidence.documentedResponsibilities.some((item) => item.includes('CSV')));
  assert.match(brief.slotBriefs[0].evidence.mustAskNotAssume, /does not prove/);
});

test('cross-category history is included in the brief without changing category objectives', () => {
  const brief = makeCategoryBrief('domain_fundamentals', buildCategoryBlueprint(resume, 'domain_fundamentals'),
    ['An endpoint returns an incorrect status code; how would you investigate?']);
  assert.equal(brief.otherCategoryQuestionsToAvoid.length, 1);
  assert.match(brief.slotBriefs[4].objective, /data structure/i);
});

test('independent reviewer checks evidence, category quality, repeats and keyword-only name insertion', () => {
  const blueprint = buildCategoryBlueprint(resume, 'project_deep_dive');
  const questions = Array.from({ length: 6 }, (_, index) => `How would you explain component ${index+1} in your project?`);
  const prompt = reviewPrompt('project_deep_dive', blueprint, questions);
  assert.match(prompt, /superficial name substitution/);
  assert.match(prompt, /JDBC and MySQL/);
  assert.equal(REVIEW_SCHEMA.properties.issues.maxItems, 6);
  assert.match(reviewedRepairPrompt('project_deep_dive', blueprint, questions,
    [{questionIndex:0, code:'generic_or_shallow'}]), /documented evidence/);
});

test('reviewer accepts sound results, rejects duplicate, invalid indices and unknown codes', () => {
  assert.deepEqual(parseReview({ issues: [] }), []);
  assert.deepEqual(parseReview({ issues: [{questionIndex: 2, code:'keyword_only_personalization'}] }),
    [{questionIndex: 2, code:'keyword_only_personalization'}]);
  assert.throws(() => parseReview({issues:[{questionIndex:2, code:'generic_or_shallow'}, {questionIndex:2, code:'category_mismatch'}]}),
    {code:'INVALID_QUALITY_REVIEW'});
  assert.throws(() => parseReview({issues:[{questionIndex:6, code:'generic_or_shallow'}]}), {code:'INVALID_QUALITY_REVIEW'});
  assert.throws(() => parseReview({issues:[{questionIndex:2, code:'bad_code'}]}), {code:'INVALID_QUALITY_REVIEW'});
});
