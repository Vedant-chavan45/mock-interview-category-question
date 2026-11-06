'use strict';

const { TECHNICAL_RULES } = require('./categoryPolicies');
const { validateTechnicalQuestion } = require('../../services/questionQualityService');
const { normalize } = require('../../services/skillAssessmentPlanner');

const GENERIC_TECH_FRAMING = /\b(?:build (?:a |an )?(?:small |simple |basic )?(?:feature|app|application)|connect (?:a |the )?technology to the rest of (?:the |an? )?app|use (?:this |a )?technology for a (?:small|simple) feature)\b/i;

const FILLER = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'about', 'can', 'could', 'describe', 'do', 'does',
  'explain', 'for', 'from', 'how', 'if', 'in', 'into', 'is', 'it', 'its', 'me', 'of',
  'on', 'or', 'the', 'their', 'then', 'this', 'to', 'using', 'what', 'when', 'where',
  'which', 'why', 'with', 'would', 'you', 'your', 'work', 'works', 'process',
]);
function words(value) {
  return (normalize(value).match(/[\p{L}\p{N}+#.]+/gu) || []);
}
function contentTokens(value) {
  return new Set(words(value).filter((token) => token.length > 2 && !FILLER.has(token)));
}
function overlap(left, right) {
  const a = contentTokens(left), b = contentTokens(right);
  if (Math.min(a.size, b.size) < TECHNICAL_RULES.minContentTokensForSimilarity) return 0;
  const matches = [...a].filter((token) => b.has(token)).length;
  return matches / (a.size + b.size - matches || 1);
}
function nearDuplicate(left, right) {
  return normalize(left) === normalize(right) ||
    overlap(left, right) >= TECHNICAL_RULES.similarQuestionJaccard;
}
function qualityFailure(code, questionIndex, message) {
  return Object.assign(new Error(message || code), { code, questionIndex });
}

// Topic labels are authored by the model, so verify them against the actual
// question instead of treating an invented label as evidence of assessment.
function validTopicLabel(question, label) {
  const terms = words(label);
  if (terms.length < TECHNICAL_RULES.minTopicWords || terms.length > TECHNICAL_RULES.maxTopicWords) return false;
  if (terms.every((term) => FILLER.has(term))) return false;
  const sequence = words(question);
  return sequence.some((_token, start) =>
    terms.every((term, offset) => sequence[start + offset] === term));
}

// Inspect every slot before requesting a repair. Returning only the first
// issue caused valid five-question portions to be discarded when two different
// slots required correction and the entire batch had just one repair attempt.
function collectCompactTechnicalIssues(items, blueprint, resumeContext, rotation = {}) {
  if (!Array.isArray(items) || items.length !== 6 || !Array.isArray(blueprint?.slots) || blueprint.slots.length !== 6) {
    throw qualityFailure('INVALID_TECHNICAL_OUTPUT', null, 'Expected six technical items and six assessment slots.');
  }
  const checked = [];
  const issues = [];
  for (const [index, item] of items.entries()) {
    const question = typeof item?.question === 'string' ? item.question.replace(/\s+/g, ' ').trim() : '';
    const wordCount = words(question).length;
    let code = null;
    if (!question.endsWith('?') || (question.match(/\?/g) || []).length !== 1 ||
        wordCount < TECHNICAL_RULES.minWords || wordCount > TECHNICAL_RULES.maxWords || question.length > 240) {
      code = 'incomplete-or-vague';
    } else if (GENERIC_TECH_FRAMING.test(question)) {
      code = 'generic-template-framing';
    } else if (!validTopicLabel(question, item.topic)) {
      code = 'unverifiable-topic-label';
    } else if (checked.some((previous) => nearDuplicate(previous, question))) {
      code = 'semantic-duplicate-question';
    } else if ((Array.isArray(rotation.previousQuestions) ? rotation.previousQuestions : [])
      .some((previous) => typeof previous === 'string' && nearDuplicate(previous, question))) {
      code = 'previously-asked-question';
    } else {
      const slot = blueprint.slots[index];
      // Existing guards: invalid comparisons, unsupported resume claims,
      // topic specificity. These checks are never skipped for accepted slots.
      code = validateTechnicalQuestion(question, slot, blueprint, resumeContext);
    }
    if (code) issues.push({ code, questionIndex: index });
    checked.push(question);
  }
  return issues;
}

function validateCompactTechnicalItems(items, blueprint, resumeContext, rotation = {}) {
  const issues = collectCompactTechnicalIssues(items, blueprint, resumeContext, rotation);
  if (issues.length) {
    const error = qualityFailure(issues[0].code, issues[0].questionIndex);
    // Only sanitised error codes and slot indices; no candidate material.
    error.qualityIssues = issues;
    throw error;
  }
  return true;
}

module.exports = {
  validateCompactTechnicalItems, collectCompactTechnicalIssues,
  validTopicLabel, nearDuplicate, overlap,
};
