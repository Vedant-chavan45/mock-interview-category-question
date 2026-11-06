'use strict';

/**
 * Phase 2C: editable interviewer standards. The profile is used to decide WHAT
 * to assess; resume evidence is used to justify candidate-specific claims.
 * We deliberately do not treat presence of a project name/technology keyword
 * as evidence that a question has been personalized.
 */
const STANDARDS_VERSION = 'interview-evidence-v1';

const CATEGORY_STANDARDS = Object.freeze({
  domain_fundamentals: Object.freeze({
    purpose: 'Assess the basic engineering understanding expected for the target role, not incident response.',
    goodQuestion: 'Ask for a mechanism, responsibility boundary, design choice, verification step or basic engineering trade-off using a concrete but simple example.',
    avoid: 'No six generic what-would-you-check-first questions; reserve outages, debugging, user incidents and troubleshooting for Applied Technical Scenarios. Do not duplicate the same concurrency/security issue.',
    personalization: 'Use the target role and employer-required competencies to select fundamentals. Do not insert project names merely to sound personalized.',
  }),
  technical_concepts: Object.freeze({
    purpose: 'Assess real depth across each of the assigned required skills, including application and reasoning.',
    goodQuestion: 'Each question tests one specific concept or trade-off and can distinguish a memorized answer from an explained mechanism.',
    avoid: 'No superficial definitions, generic technology-name insertion, false claims of experience, or poorly specified algorithmic assumptions.',
    personalization: 'Match skill coverage and role level; a generic technical question is acceptable when it genuinely assesses a job requirement.',
  }),
  project_deep_dive: Object.freeze({
    purpose: 'Verify genuine understanding of listed projects, individual ownership and important implementation choices.',
    goodQuestion: 'Use documented project functionality and technologies to probe a specific data flow, component decision, algorithm, implementation boundary, debugging method or test. Ask the candidate to supply any undocumented detail.',
    avoid: 'A project title pasted into a generic troubleshooting question is NOT personalization. Do not presume specific internal architecture, responsibilities, bugs, measurable results or features absent from the resume.',
    personalization: 'Anchor questions to the description and documented stack of each assigned project, not just its name. Only one broad overview and one ownership question are normally appropriate per set.',
  }),
  professional_experience: Object.freeze({
    purpose: 'Verify what the candidate actually did in documented work, internship or practical projects.',
    goodQuestion: 'Ask about the exact responsibility, approach, technical decisions, inputs/outputs, verification and learning suggested by the evidence.',
    avoid: 'Never fabricate a vulnerability they found, a teammate conflict, a team they led, a bug they fixed or an achievement not stated. An open-ended invitation is appropriate when details are missing.',
    personalization: 'Ground the question in documented responsibilities. If no formal employment is listed, call it project or practical work, not an internship.',
  }),
  applied_scenarios: Object.freeze({
    purpose: 'Assess how the candidate reasons through distinct realistic engineering situations.',
    goodQuestion: 'Each scenario has (a) an observable symptom or goal, (b) at least one concrete technical constraint or clue, and (c) a decision or diagnostic action the candidate can defend.',
    avoid: 'No generic "a feature stopped working, what do you check?" questions, no mere project-name substitution, and no repetition of Role Fundamentals incidents. Make six scenarios meaningfully different.',
    personalization: 'Prefer relevant documented system behavior or technologies only when the resume supports that context; otherwise write a realistic role-based hypothetical without suggesting it happened.',
  }),
  behavioral_collaboration: Object.freeze({
    purpose: 'Assess communication, asking for help, accountability, feedback, collaboration, prioritization and learning rather than technical troubleshooting.',
    goodQuestion: 'Ask for a real example when there is evidence, or clearly frame a plausible hypothetical. Make the interpersonal decision the center of the question.',
    avoid: 'Do not assert that a disagreement, teammate delay, major mistake, or management role happened unless evidenced. Do not re-ask professional ownership or technical bug-fixing questions.',
    personalization: 'Connect to a documented work/learning context if useful, but never invent a past event to personalize the question.',
  }),
});

const ROLE_FUNDAMENTALS = Object.freeze({
  generic: Object.freeze([
    'Explain the boundary between user interface, application logic, APIs and persistence using an ordinary feature request.',
    'Explain how basic data should be modeled, validated and kept consistent in an application (not an incident investigation).',
    'Distinguish authentication from authorization and where each must be enforced.',
    'Explain a practical test strategy for a small feature, including success, failure and edge cases.',
    'Reason about choosing a basic algorithm or data structure and estimating its time/space cost as input grows.',
    'Describe how an intern would plan, implement, review and deliver a maintainable change using Git.',
  ]),
  backend: Object.freeze([
    'Trace an HTTP request through route, validation, business logic and persistence, and explain responsibility boundaries.',
    'Explain data modeling and input validation for a small backend feature; distinguish a correct design from a debugging incident.',
    'Distinguish authentication from authorization and describe where server-side checks belong.',
    'Explain unit versus integration tests for an API and identify important edge cases and response codes.',
    'Explain how a data structure or algorithm choice affects time and memory cost of an API operation.',
    'Explain a maintainable approach to structuring an API change, testing it and submitting it for review in Git.',
  ]),
  fullstack: Object.freeze([
    'Trace a user action through browser, frontend state, API and database, with clear responsibility boundaries.',
    'Explain client-side versus server-side validation and how to keep the visible state consistent with saved data.',
    'Explain authentication and authorization across frontend and backend, including why hiding a button is not authorization.',
    'Explain meaningful front-end and backend tests for an ordinary feature and what edge cases to verify.',
    'Choose an appropriate data structure or approach for rendering, searching or updating a growing list.',
    'Explain how to make and review a maintainable change across frontend, API and version control.',
  ]),
});

const text = (value) => typeof value === 'string' ? value.trim() : '';
const list = (value) => Array.isArray(value) ? value : [];
const compact = (value, max = 230) => text(value).replace(/\s+/g, ' ').slice(0, max);

function fundamentalsObjective(roleProfile, index) {
  // Preserve existing role-specific tracks (QA, systems, data, AI/ML,
  // frontend). The generic/software-intern track is intentionally redesigned,
  // but must not overwrite another domain's specialized assessment objectives.
  const values = ROLE_FUNDAMENTALS[roleProfile];
  return values?.[index] || '';
}

/** Grounded, slot-matched evidence card. No inferred architecture or achievements. */
function evidenceForSlot(categoryId, slot) {
  const supporting = slot.supportingEvidence || {};
  if (categoryId === 'project_deep_dive') {
    return {
      evidenceId: slot.evidence.id || null,
      documentedProjectTitle: compact(supporting.title, 100) || null,
      documentedFunctionality: compact(supporting.description, 260) || null,
      documentedTechnologies: list(supporting.technologies).map((item) => compact(item, 60)).filter(Boolean).slice(0, 10),
      mustAskNotAssume: 'Architecture, author contributions, features, failures and outcomes not explicitly documented are UNKNOWN; ask the candidate rather than assert them.',
    };
  }
  if (categoryId === 'professional_experience') {
    return {
      evidenceId: slot.evidence.id || null,
      role: compact(supporting.role, 100) || null,
      organisation: compact(supporting.organisation, 100) || null,
      documentedResponsibility: compact(supporting.selectedResponsibility, 230) || null,
      documentedResponsibilities: list(supporting.responsibilities).slice(0, 4).map((item) => compact(item, 210)),
      practicalProject: Boolean(supporting.practicalExperience),
      documentedProjectTitle: compact(supporting.title, 100) || null,
      documentedProjectDescription: compact(supporting.description, 230) || null,
      mustAskNotAssume: 'A listed responsibility does not prove a particular incident, contribution, tool decision, outcome or collaboration event occurred.',
    };
  }
  return { evidenceId: slot.evidence.id || null, evidenceKind: slot.evidence.provenance.kind };
}

function makeCategoryBrief(categoryId, blueprint, previousCrossCategoryQuestions = []) {
  const policy = CATEGORY_STANDARDS[categoryId];
  if (!policy) return null;
  return {
    category: categoryId,
    role: blueprint.role,
    seniority: /\b(intern|trainee|junior|graduate|entry.level|student)\b/i.test(blueprint.role) ? 'intern/entry-level' : 'match role, prefer practical reasoning',
    categoryContract: policy,
    slotBriefs: blueprint.slots.map((slot, index) => ({
      slot: index + 1,
      slotId: slot.slotId,
      objective: categoryId === 'domain_fundamentals'
        ? fundamentalsObjective(blueprint.roleProfile, index) || slot.objective
        : slot.objective,
      evidence: evidenceForSlot(categoryId, slot),
    })),
    otherCategoryQuestionsToAvoid: previousCrossCategoryQuestions.slice(-24).map((q) => compact(q, 210)),
  };
}

module.exports = { STANDARDS_VERSION, CATEGORY_STANDARDS, ROLE_FUNDAMENTALS, fundamentalsObjective, evidenceForSlot, makeCategoryBrief };
