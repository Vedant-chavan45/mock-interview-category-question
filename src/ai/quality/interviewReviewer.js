'use strict';

const { makeCategoryBrief } = require('./interviewStandards');

/** Optional independent semantic review. Fully model-agnostic; provider is
 * selected by the existing gateway. Reviewers must reject only clear errors,
 * NOT simply questions they would phrase differently. */
const ISSUE_CODES = Object.freeze([
  'category_mismatch', 'keyword_only_personalization', 'unsupported_resume_claim',
  'generic_or_shallow', 'repeated_competency', 'unclear_or_unanswerable',
  'technical_inaccuracy', 'inappropriate_role_difficulty',
]);
const CODE_SET = new Set(ISSUE_CODES);

const REVIEW_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    issues: {
      type: 'array', maxItems: 6,
      items: {
        type: 'object',
        properties: {
          questionIndex: { type: 'integer', minimum: 0, maximum: 5 },
          code: { type: 'string', enum: ISSUE_CODES },
        },
        required: ['questionIndex', 'code'],
        additionalProperties: false,
      },
    },
  },
  required: ['issues'], additionalProperties: false,
});

function reviewPrompt(categoryId, blueprint, questions, crossCategoryQuestions = []) {
  const brief = makeCategoryBrief(categoryId, blueprint, crossCategoryQuestions);
  if (!brief || !Array.isArray(questions) || questions.length !== 6) throw new Error('Invalid interview review inputs.');
  return `You are an independent, strict but fair software-interview question reviewer. Review the EXACT six questions for category ${categoryId}, role ${JSON.stringify(blueprint.role)}. ` +
    `Evaluate actual interview usefulness, not word matches. A project name inserted into a generic question is not personalization. ` +
    `Use only evidence explicitly provided. A selected employer skill is NOT proof the candidate has worked with it. ` +
    `Category boundaries: fundamentals test basic software understanding; technical concepts assess specific required skills; ` +
    `projects verify implementation and ownership; experience verifies documented work; applied scenarios require a specific realistic symptom and constraint; behavioral questions assess people skills without assuming incidents occurred. ` +
    `Do not reject a well-designed general technical question because it lacks a project name. Do not demand keyword overlap to prove grounding. ` +
    `Reject only CLEAR, material defects: wrong category, superficial name substitution, fabricated personal claims, generic/unanswerable wording, a repeated competency with no new perspective, technically misleading premise, or inappropriate level. ` +
    `A correct, answerable question that you would phrase differently should PASS. Consider each question with its assigned slot and all other questions. ` +
    `REVIEW_STANDARD_AND_EVIDENCE: ${JSON.stringify(brief)}\n` +
    `QUESTIONS: ${JSON.stringify(questions.map((question, questionIndex) => ({questionIndex, question})))}\n` +
    `Only return JSON {"issues":[{"questionIndex":0,"code":"generic_or_shallow"}]} or {"issues":[]}. ` +
    `Include each rejected index once, using one exact code from ${JSON.stringify(ISSUE_CODES)}. No explanation or private data.`;
}

function parseReview(value, count = 6) {
  if (!value || typeof value !== 'object' || !Array.isArray(value.issues)) {
    throw Object.assign(new Error('Invalid independent review format.'), { code: 'INVALID_QUALITY_REVIEW' });
  }
  const indices = new Set();
  return value.issues.map((entry) => {
    if (!Number.isInteger(entry?.questionIndex) || entry.questionIndex < 0 || entry.questionIndex >= count ||
        !CODE_SET.has(entry.code) || indices.has(entry.questionIndex)) {
      throw Object.assign(new Error('Invalid independent review result.'), { code: 'INVALID_QUALITY_REVIEW' });
    }
    indices.add(entry.questionIndex);
    return { questionIndex: entry.questionIndex, code: entry.code };
  });
}

function reviewedRepairPrompt(categoryId, blueprint, questions, issues, crossCategoryQuestions = []) {
  const brief = makeCategoryBrief(categoryId, blueprint, crossCategoryQuestions);
  const bad = new Set(issues.map((issue) => issue.questionIndex));
  return `You are rewriting only the weak questions for a real ${JSON.stringify(blueprint.role)} interview. ` +
    `Use precise category intent, documented evidence, and a realistic intern-level challenge. ` +
    `Do NOT personalize by pasting project titles or technology keywords into generic questions. ` +
    `Do NOT invent past incidents, owned components, teamwork or accomplishments. ` +
    `Keep the other approved questions unchanged; replacements MUST NOT repeat their objective or the cross-category history. ` +
    `Return exactly ${issues.length} new questions in REJECTED order. All must be standalone and end with one question mark. ` +
    `REJECTED: ${JSON.stringify(issues.map(({questionIndex, code}) => ({
      questionIndex, code, question: questions[questionIndex],
      slot: brief.slotBriefs[questionIndex],
    })))}\n` +
    `ACCEPTED: ${JSON.stringify(questions.filter((_, index) => !bad.has(index)))}\n` +
    `OTHER_CATEGORIES: ${JSON.stringify(crossCategoryQuestions.slice(-24))}\n` +
    `Return only JSON {"questions":["replacement question?",...]}.`;
}

module.exports = { ISSUE_CODES, REVIEW_SCHEMA, reviewPrompt, parseReview, reviewedRepairPrompt };
