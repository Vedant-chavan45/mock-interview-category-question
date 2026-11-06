'use strict';

// Edit this module to raise standards for an individual interview category.
// These are guidance and deterministic checks, not a substitute for expert
// technical review. Changes can be benchmarked without switching AI models.
const CATEGORY_POLICIES = Object.freeze({
  domain_fundamentals: Object.freeze({
    focus: 'Assess six distinct role fundamentals; do not ask two questions about the same failure or concurrency scenario under different wording.',
  }),
  technical_concepts: Object.freeze({
    focus: 'Assess the specific mechanism, trade-off, failure case or API behavior of each assigned technical skill. Avoid generic definitions or invented candidate experience.',
  }),
  project_deep_dive: Object.freeze({
    focus: 'Use documented projects and technologies. Probe architecture, a real data flow, design decisions, troubleshooting, testing and actual contribution. Ask about missing facts; never invent achievements.',
  }),
  professional_experience: Object.freeze({
    focus: 'Ask about documented responsibilities and decisions, not imagined employment, employers, metrics or technology experience.',
  }),
  applied_scenarios: Object.freeze({
    focus: 'Use six meaningfully different workplace scenarios with concrete constraints, covering debugging, reliability, security, performance, data correctness and prioritization as appropriate to the role.',
  }),
  behavioral_collaboration: Object.freeze({
    focus: 'Assess distinct people skills such as ownership, communication, feedback, disagreements, cooperation and prioritization without asserting undocumented teamwork.',
  }),
});

const TECHNICAL_RULES = Object.freeze({
  minWords: 9,
  maxWords: 45,
  minTopicWords: 2,
  maxTopicWords: 5,
  similarQuestionJaccard: 0.80,
  minContentTokensForSimilarity: 4,
  // Maximum batch repair rounds (not maximum invalid questions per batch).
  maxRepairs: 2,
});

function categoryFocus(categoryId) { return CATEGORY_POLICIES[categoryId]?.focus || ''; }

module.exports = { CATEGORY_POLICIES, TECHNICAL_RULES, categoryFocus };
