'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { CATEGORY_POLICIES, categoryFocus } = require('../src/ai/quality/categoryPolicies');
const { validTopicLabel, nearDuplicate, validateCompactTechnicalItems } = require('../src/ai/quality/compactTechnicalGate');

const samples = [
  ['How does the Node.js event loop schedule timer callbacks among its different phases?', 'event loop schedule'],
  ['How does Express middleware execution order affect error handling for a request?', 'middleware execution order'],
  ['How does MongoDB write concern majority affect acknowledgment after primary elections?', 'write concern majority'],
  ['When a readable stream is slow, how does Node.js apply backpressure to producers?', 'apply backpressure to producers'],
  ['How should Express error handling middleware propagate asynchronous failures to the next handler?', 'error handling middleware'],
  ['How does MongoDB lookup aggregation behave when the joined collection is sharded?', 'lookup aggregation behave'],
];
const items = samples.map(([question, topic]) => ({ question, topic }));
const blueprint = {
  slots: samples.map(([question, topic], index) => ({ slotId: `technical_${index + 1}`,
    primaryAssessmentTarget: ['Node.js', 'Express', 'MongoDB', 'Node.js', 'Express', 'MongoDB'][index],
    primaryRequiredSkill: ['Node.js', 'Express', 'MongoDB', 'Node.js', 'Express', 'MongoDB'][index],
    subtopic: topic, keyTerms: [topic], skillKind: 'core_concept' })),
  skillClassifications: [],
};
const resume = { skills: ['Node.js', 'Express', 'MongoDB'] };
function check(values, history = []) {
  const liveBlueprint = { ...blueprint, slots: blueprint.slots.map((slot, i) => ({ ...slot,
    subtopic: values[i]?.topic, keyTerms: [values[i]?.topic] })) };
  return validateCompactTechnicalItems(values, liveBlueprint, resume, { previousQuestions: history });
}

test('editable quality policy covers all six categories', () => {
  assert.equal(Object.keys(CATEGORY_POLICIES).length, 6);
  for (const key of Object.keys(CATEGORY_POLICIES)) assert.ok(typeof categoryFocus(key) === 'string' && categoryFocus(key).trim());
});
test('valid technical questions pass a focused quality gate', () => assert.equal(check(items), true));
test('technical topic label must be a consecutive, substantive phrase in its actual question', () => {
  assert.equal(validTopicLabel(items[0].question, items[0].topic), true);
  assert.equal(validTopicLabel(items[0].question, 'event timers thread'), false);
  assert.throws(() => check(items.map((item, index) => index === 2 ? { ...item, topic: 'not really in question' } : item)), { code: 'unverifiable-topic-label', questionIndex: 2 });
});
test('technical questions must assess an actual concept, not a generic feature', () => {
  const changed = items.slice();
  changed[0] = { question: 'How would you use Node.js to build a small feature for your application?', topic: 'a small feature' };
  assert.throws(() => check(changed), { code: 'generic-template-framing', questionIndex: 0 });
});
test('near duplicate questions in a batch or previous history trigger targeted rejection', () => {
  assert.equal(nearDuplicate(items[0].question, 'How does the Node.js event loop schedule timer callbacks among its different phases?'), true);
  const changed = items.slice();
  changed[3] = { question: items[0].question, topic: items[0].topic };
  assert.throws(() => check(changed), { code: 'semantic-duplicate-question', questionIndex: 3 });
  assert.throws(() => check(items, [items[0].question]), { code: 'previously-asked-question', questionIndex: 0 });
});
test('unsupported past experience with employer-required skill is rejected', () => {
  const changed = items.slice();
  changed[0] = { question: 'How did you use Node.js event loop scheduling in your previous work?', topic: 'event loop scheduling' };
  assert.throws(() => validateCompactTechnicalItems(changed, blueprint, { skills: [] }), { code: 'unsupported-required-skill-experience', questionIndex: 0 });
});
test('different technical skills are not judged duplicates for sharing ordinary words', () => {
  assert.equal(nearDuplicate(items[1].question, items[4].question), false);
});
