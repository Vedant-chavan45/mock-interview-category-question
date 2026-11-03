/** Pure AI-output validation. Throws internally; callers return their existing fallback. */
const MAX_QUESTION_LENGTH = 240;
const MAX_BASED_ON_LENGTH = 120;
const TYPES = new Set(['technical', 'project', 'behavioral', 'experience']);
const { QUESTION_COUNT_PER_CATEGORY } = require('./questionCategories');
const { buildCategoryBlueprint, contextData } = require('./categoryBlueprintService');
const { validateTechnicalQuestion } = require('./questionQualityService');
const { makeCoverageSignature } = require('./skillAssessmentPlanner');
const text = (v) => typeof v === 'string' ? v.trim() : '';
const list = (v) => Array.isArray(v) ? v : [];
const object = (v) => v && typeof v === 'object' && !Array.isArray(v) ? v : {};
const plain = (v) => v !== null && typeof v === 'object' &&
  (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);
const words = (v) => (text(v).toLowerCase().match(/[\p{L}\p{N}]+(?:[.+#]+[\p{L}\p{N}]*)*/gu) || [])
  .map((token) => token.replace(/\.+$/, ''));
const connectors = new Set(['the', 'a', 'an', 'and', 'or', 'at', 'in', 'of', 'for', 'with',
  'project', 'projects', 'experience', 'role', 'skill', 'skills']);
const duplicateKey = (v) => v.toLowerCase().trim().replace(/\s+/g, ' ').replace(/[.!?,;:]+$/, '').trim();
const shortAnchor = (value) => {
  const anchor = text(value).replace(/\s+/g, ' ');
  if (anchor.length <= MAX_BASED_ON_LENGTH) return anchor;
  const cut = anchor.slice(0, MAX_BASED_ON_LENGTH - 1);
  const boundary = cut.lastIndexOf(' ');
  return `${(boundary > MAX_BASED_ON_LENGTH * 0.6 ? cut.slice(0, boundary) : cut).trim()}…`;
};

function fail(code, questionCount, questionIndex, safeDetails = {}) {
  const error = new Error('Invalid generated questions.');
  error.code = code;
  if (Number.isSafeInteger(questionCount) && questionCount >= 0) error.questionCount = questionCount;
  if (Number.isSafeInteger(questionIndex) && questionIndex >= 0) error.questionIndex = questionIndex; // zero-based
  if (safeDetails.actualTypeCounts) error.actualTypeCounts = safeDetails.actualTypeCounts;
  if (safeDetails.expectedTypeCounts) error.expectedTypeCounts = safeDetails.expectedTypeCounts;
  throw error;
}

function groundingData(resumeContext, interviewPlan) {
  const c = object(resumeContext);
  const anchors = [];
  const add = (v) => { if (text(v)) anchors.push(text(v)); };
  list(c.skills).forEach(add);
  add(c.targetRole);
  const projects = list(c.projects).map(object).filter((p) =>
    text(p.title) || text(p.description) || list(p.technologies).some(text));
  projects.forEach((p) => { add(p.title); add(p.description); list(p.technologies).forEach(add); });
  const experience = list(c.experience).map(object).filter((e) =>
    text(e.role) || text(e.organisation) || text(e.duration) || list(e.responsibilities).some(text));
  experience.forEach((e) => {
    add(e.role); add(e.organisation); add(e.duration); list(e.responsibilities).forEach(add);
  });
  add(c.experienceSummary);
  list(c.education).forEach((value) => {
    const e = object(value); add(e.degree); add(e.institution); add(e.year);
  });
  list(object(interviewPlan).focusAreas).forEach((value) => {
    const area = object(value); add(area.topic); list(area.evidence).forEach(add);
  });
  return { tokens: new Set(anchors.flatMap(words)), hasProjects: projects.length > 0,
    hasExperience: experience.length > 0 || !!text(c.experienceSummary) };
}

function isDefinition(question) {
  // Only short, standalone definition requests without personal/application context.
  const q = question.replace(/\s+/g, ' ').trim();
  return /^(?:what (?:is|are)|define)\s+[^?!;]+[?.!]*$/i.test(q) &&
    words(q).length <= 12 &&
    !/\b(you|your|our|how|why|when|where|in|for|during|would|could|should)\b/i.test(q);
}

function validateGeneratedQuestions(result, resumeContext, interviewPlan, options = {}) {
  const questionCount = Array.isArray(result?.questions) ? result.questions.length : undefined;
  if (!plain(result) || Reflect.ownKeys(result).length !== 1 ||
      !Object.hasOwn(result, 'questions') || !Array.isArray(result.questions)) fail('invalid-envelope', questionCount);
  if (questionCount !== (options.questionCount || 6)) fail('wrong-question-count', questionCount);
  const grounding = groundingData(resumeContext, interviewPlan);
  const seen = new Set();
  const counts = { technical: 0, project: 0, behavioral: 0, experience: 0 };
  const questions = [];
  for (const [questionIndex, item] of result.questions.entries()) {
    if (!plain(item) || Reflect.ownKeys(item).length !== 3 ||
        !['question', 'type', 'basedOn'].every((key) => Object.hasOwn(item, key) && typeof item[key] === 'string')) fail('invalid-item-shape', questionCount, questionIndex);
    const question = item.question.trim();
    const type = item.type.trim();
    const basedOn = item.basedOn.trim();
    if (!question || question.length > MAX_QUESTION_LENGTH || !basedOn ||
        basedOn.length > MAX_BASED_ON_LENGTH) fail('empty-or-oversized-field', questionCount, questionIndex);
    if (!TYPES.has(type)) fail('invalid-type', questionCount, questionIndex);
    const key = duplicateKey(question);
    if (!key || seen.has(key)) fail('duplicate-question', questionCount, questionIndex);
    if (isDefinition(question)) fail('generic-definition', questionCount, questionIndex);
    seen.add(key);
    const tokens = words(basedOn).filter((token) => !connectors.has(token));
    const general = type === 'behavioral' && basedOn.toLowerCase() === 'general';
    // Whole tokens allow combined anchors while rejecting unsupported additions and substrings.
    if (!general && (!tokens.length || !tokens.every((token) => grounding.tokens.has(token)))) fail('invalid-grounding', questionCount, questionIndex);
    counts[type] += 1;
    questions.push({ question, type, basedOn });
  }
  const expectedTypeCounts = {
    technical: 6 - (grounding.hasProjects ? 2 : 0) - (grounding.hasExperience ? 1 : 0) - 1,
    project: grounding.hasProjects ? 2 : 0,
    experience: grounding.hasExperience ? 1 : 0,
    behavioral: 1,
  };
  if (!options.skipDistribution && (counts.behavioral !== 1 || counts.technical < 2 ||
      (grounding.hasProjects ? counts.project < 2 : counts.project !== 0) ||
      counts.experience !== (grounding.hasExperience ? 1 : 0))) {
    fail('invalid-distribution', questionCount, undefined, {
      actualTypeCounts: counts, expectedTypeCounts,
    });
  }
  return questions;
}

function normalizeSpokenQuestion(value) {
  const clean = text(value).replace(/\s+/g, ' ').trim();
  if (!clean) return '';
  if (clean.endsWith('?')) return clean;
  // The model contract is a list of interview questions. Normalize punctuation
  // without deciding what words a question is allowed to start with.
  const body = clean.replace(/[.!?]+$/, '').trim();
  return body ? `${body}?` : '';
}

const KNOWN_TECHNOLOGIES = [
  ['Redis', /\bredis\b/i], ['PostgreSQL', /\bpostgres(?:ql)?\b/i], ['MySQL', /\bmysql\b/i],
  ['SQLite', /\bsqlite\b/i], ['Kafka', /\bkafka\b/i], ['Kubernetes', /\bkubernetes\b/i],
  ['Docker', /\bdocker\b/i], ['AWS', /\baws\b/i], ['Azure', /\bazure\b/i], ['GCP', /\bgcp\b/i],
  ['React', /\breact(?:\.js)?\b/i], ['Angular', /\bangular\b/i], ['Vue', /\bvue(?:\.js)?\b/i],
  ['Django', /\bdjango\b/i], ['Flask', /\bflask\b/i], ['FastAPI', /\bfastapi\b/i],
  ['Spring', /\bspring(?: boot)?\b/i], ['Java', /\bjava\b/i], ['Python', /\bpython\b/i],
  ['.NET', /(?:^|\W)\.net(?=\W|$)/i], ['GraphQL', /\bgraphql\b/i], ['Elasticsearch', /\belasticsearch\b/i],
  ['Node.js', /\bnode(?:\.js)?\b/i], ['Express', /\bexpress(?:\.js)?\b/i], ['Socket.io', /\bsocket(?:\.io)?\b/i],
  ['MongoDB', /\bmongodb\b/i], ['Mongoose', /\bmongoose\b/i], ['JWT', /\bjwt\b/i], ['OAuth', /\boauth\b/i],
  ['TypeScript', /\btypescript\b/i], ['JavaScript', /\bjavascript\b/i], ['C++', /(?:^|\W)c\+\+(?=\W|$)/i], ['C#', /(?:^|\W)c#(?=\W|$)/i],
  ['Golang', /\bgolang\b/i], ['Rust', /\brust\b/i], ['Ruby', /\bruby\b/i], ['PHP', /\bphp\b/i],
  ['Cassandra', /\bcassandra\b/i], ['DynamoDB', /\bdynamodb\b/i], ['Firebase', /\bfirebase\b/i],
  ['Supabase', /\bsupabase\b/i], ['RabbitMQ', /\brabbitmq\b/i], ['Postman', /\bpostman\b/i],
  ['Selenium', /\bselenium\b/i], ['Playwright', /\bplaywright\b/i], ['Cypress', /\bcypress\b/i],
  ['PyTorch', /\bpytorch\b/i], ['TensorFlow', /\btensorflow\b/i], ['scikit-learn', /\bscikit(?:[- ]learn)\b/i],
  ['Pandas', /\bpandas\b/i], ['NumPy', /\bnumpy\b/i], ['Apache Spark', /\bspark\b/i], ['Hadoop', /\bhadoop\b/i],
  ['Airflow', /\bairflow\b/i], ['Snowflake', /\bsnowflake\b/i], ['BigQuery', /\bbigquery\b/i],
  ['Next.js', /\bnext(?:\.js|js)\b/i], ['NestJS', /\bnestjs\b/i], ['Prisma', /\bprisma\b/i],
  ['TypeORM', /\btypeorm\b/i], ['Sequelize', /\bsequelize\b/i], ['Tailwind CSS', /\btailwind(?: css)?\b/i],
  ['Bootstrap', /\bbootstrap\b/i], ['HTML', /\bhtml5?\b/i], ['CSS', /\bcss3?\b/i],
  ['Jest', /\bjest\b/i], ['JUnit', /\bjunit\b/i], ['pytest', /\bpytest\b/i], ['Mocha', /\bmocha\b/i],
  ['Git', /\bgit\b/i], ['GitHub', /\bgithub\b/i], ['Linux', /\blinux\b/i],
  ['Kotlin', /\bkotlin\b/i], ['Swift', /\bswift\b/i], ['MLflow', /\bmlflow\b/i],
];

function normalizedPhrase(value) {
  return text(value).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ');
}

function containsPhrase(haystack, needle) {
  const source = ` ${normalizedPhrase(haystack)} `;
  const target = ` ${normalizedPhrase(needle)} `;
  return target.length > 2 && source.includes(target);
}

function provenanceIsValid(slot, resumeContext) {
  const c = contextData(resumeContext);
  const { kind, recordIndex, field, itemIndex } = slot.evidence.provenance;
  if (kind === 'role_fundamental' || kind === 'role_scenario') return slot.evidence.anchor === c.targetRole;
  if (kind === 'general_behavioral_prompt') return slot.evidence.anchor === 'general';
  if (kind === 'required_skill_assessment') return field === 'requiredSkillset' && c.requiredSkillset.some((skill) => skill === slot.evidence.anchor);
  if (kind === 'missing_resume_skill') return c.skills.length === 0 && !c.projects.some((project) => project.technologies.length);
  if (kind === 'missing_resume_project') return c.projects.length === 0;
  if (kind === 'missing_resume_experience') return !c.experience.length && !c.experienceSummary && !c.projects.length;
  if (kind === 'resume_skill') return c.skills[recordIndex] === slot.evidence.anchor && field === 'skills';
  if (kind === 'resume_project_technology') return c.projects[recordIndex]?.technologies[itemIndex] === slot.evidence.anchor && field === 'technologies';
  if (kind === 'resume_project' && field === 'title') return shortAnchor(c.projects[recordIndex]?.title, MAX_BASED_ON_LENGTH) === slot.evidence.anchor;
  if (kind === 'resume_project' && field === 'description') return shortAnchor(c.projects[recordIndex]?.description, MAX_BASED_ON_LENGTH) === slot.evidence.anchor;
  if (kind === 'resume_project' && field === 'technologies') return c.projects[recordIndex]?.technologies[itemIndex] === slot.evidence.anchor;
  if (kind === 'resume_experience') {
    const entry = c.experience[recordIndex];
    if (!entry) return false;
    if (field === 'role') return slot.evidence.anchor === shortAnchor([entry.role, entry.organisation].filter(Boolean).join(' at '), MAX_BASED_ON_LENGTH);
    if (field === 'organisation') return slot.evidence.anchor === shortAnchor(entry.organisation, MAX_BASED_ON_LENGTH);
    return field === 'responsibilities' && slot.evidence.anchor === shortAnchor(entry.responsibilities[itemIndex], MAX_BASED_ON_LENGTH);
  }
  if (kind === 'resume_experience_summary') return field === 'experienceSummary' && slot.evidence.anchor === shortAnchor(c.experienceSummary, MAX_BASED_ON_LENGTH);
  return false;
}

// Required skillset values are interview priorities, not proof of candidate
// proficiency. They may make a technology eligible to appear in a question,
// but they are deliberately excluded from resume grounding and evidence IDs.
function requiredSkillNames(resumeContext, normalizedContext) {
  const rawContext = object(resumeContext);
  const normalized = object(normalizedContext);
  const structured = object(rawContext.structuredEvidence);
  const candidates = [
    ...list(normalized.requiredSkillset),
    ...list(rawContext.requiredSkillset),
    ...list(structured.requiredSkillset),
  ];
  return [...new Set(candidates.map((item) => {
    if (typeof item === 'string') return text(item);
    const entry = object(item);
    return text(entry.name) || text(entry.skill) || text(entry.value);
  }).filter(Boolean))];
}

function hasUnsupportedTechnology(question, resumeContext, options = {}) {
  const c = contextData(resumeContext);
  const structuredText = [
    c.targetRole, ...c.skills, ...c.projects.flatMap((project) => [project.title, project.description, ...project.technologies]),
    ...c.experience.flatMap((entry) => [entry.role, entry.organisation, ...entry.responsibilities]),
  ].join(' ');
  const requiredSkillsText = options.allowRequiredSkills
    ? requiredSkillNames(resumeContext, c).join(' ')
    : '';
  return KNOWN_TECHNOLOGIES.find(([name, pattern]) => pattern.test(question) &&
    !pattern.test(structuredText) && !pattern.test(requiredSkillsText))?.[0] || '';
}

// Technical concept questions may legitimately mention a comparison tool or
// industry-standard alternative that the candidate did not list. Such a name
// is NOT evidence of having used it. Reject only language that asserts prior
// personal experience with the unlisted tool. Project/experience categories
// retain their stricter grounding requirements below.
function allegesUndocumentedTechnologyExperience(question, technology) {
  if (!technology) return false;
  const priorUse = /\b(?:how did you use|how have you used|when did you use|when have you used|describe (?:how )?you (?:used|implemented|built|deployed|configured)|tell me how you (?:used|implemented|built|deployed)|based on your (?:work|experience|project)|in your (?:previous|past|last|recent) (?:project|role)|from your (?:project|job|internship|experience)|your experience with)\b/i;
  const claim = /\b(?:your|you)\b.{0,70}\b(?:used|implemented|built|deployed|configured|worked with|experience|project)\b|\b(?:experience|project|implementation)\b.{0,45}\byou(?:r)?\b/i;
  return priorUse.test(question) || claim.test(question);
}

function hasUnsupportedExperienceEntity(question, resumeContext) {
  const c = contextData(resumeContext);
  const knownText = [c.targetRole, ...c.experience.flatMap((entry) => [entry.role, entry.organisation]),
    ...c.projects.map((project) => project.title)].filter(Boolean).join(' ');
  const employerPattern = /\b(?:at|for)\s+([A-Z][\p{L}\p{N}&'.-]*(?:\s+[A-Z][\p{L}\p{N}&'.-]*){0,3})/gu;
  for (const match of question.matchAll(employerPattern)) {
    if (!containsPhrase(knownText, match[1])) return match[1];
  }
  // Restrict this to title-cased role names. A broad lazy capture can mistake
  // ordinary wording such as 'your tasks in your Software Intern role' for
  // an invented role called 'tasks in your Software Intern'.
  const rolePattern = /\byour\s+([A-Z][\p{L}\p{N}&'.-]*(?:\s+[A-Z][\p{L}\p{N}&'.-]*){0,4})\s+role\b/gu;
  for (const match of question.matchAll(rolePattern)) {
    if (!containsPhrase(knownText, match[1])) return match[1];
  }
  return '';
}

// Cross-generation duplicate prevention. Match identical wording despite
// punctuation, and very similar content-token questions without blocking
// legitimate new questions about the same technology.
function previousQuestionMatches(current, previous) {
  const a = normalizedPhrase(current);
  const b = normalizedPhrase(previous);
  if (!a || !b) return false;
  if (a === b) return true;
  const ignore = new Set(['how', 'would', 'you', 'what', 'when', 'where', 'which', 'why', 'the',
    'a', 'an', 'in', 'on', 'for', 'of', 'to', 'your', 'this', 'that', 'and', 'or', 'do', 'does',
    'can', 'could', 'if', 'with', 'using', 'use', 'explain', 'tell', 'me', 'about']);
  const tokens = (value) => new Set(value.split(' ').filter((part) => part.length > 2 && !ignore.has(part)));
  const x = tokens(a);
  const y = tokens(b);
  if (Math.min(x.size, y.size) < 3) return false;
  const intersection = [...x].filter((word) => y.has(word)).length;
  const union = new Set([...x, ...y]).size;
  return intersection / union >= 0.82;
}

// The blueprint owns topics and evidence. Technical questions also pass a
// topicality gate that requires a substantive planned subtopic signal.
function validateGeneratedCategoryQuestions(result, resumeContext, interviewPlan, category, blueprint = buildCategoryBlueprint(resumeContext, category.id, interviewPlan), options = {}) {
  const questionCount = Array.isArray(result?.questions) ? result.questions.length : undefined;
  if (!plain(result) || Reflect.ownKeys(result).length !== 1 || !Object.hasOwn(result, 'questions') || !Array.isArray(result.questions)) fail('invalid-envelope', questionCount);
  if (questionCount !== QUESTION_COUNT_PER_CATEGORY) fail('wrong-question-count', questionCount);
  const seen = new Set();
  const bySlot = new Map();
  const validEvidenceIds = new Set([contextData(resumeContext).targetRoleEvidenceId,
    ...contextData(resumeContext).skillEvidence.map((item) => item.id),
    ...contextData(resumeContext).projects.map((item) => item.id),
    ...contextData(resumeContext).experience.map((item) => item.id),
    ...(contextData(resumeContext).experienceSummary ? ['experience_summary'] : []),
  ]);
  const expectedSlots = new Map(blueprint.slots.map((slot) => [slot.slotId, slot]));
  const questionItems = result.questions.map((item, index) => typeof item === 'string'
    ? { slotId: blueprint.slots[index]?.slotId, question: item,
      evidenceIds: blueprint.slots[index]?.evidence.id ? [blueprint.slots[index].evidence.id] : [] }
    : item);
  questionItems.forEach((item, index) => {
    if (!plain(item) || Reflect.ownKeys(item).length !== 3 ||
        !['slotId', 'question', 'evidenceIds'].every((key) => Object.hasOwn(item, key))) fail('invalid-item-shape', questionCount, index);
    if (typeof item.slotId !== 'string' || !expectedSlots.has(item.slotId)) fail('invalid-slot-id', questionCount, index);
    if (bySlot.has(item.slotId)) fail('duplicate-slot-id', questionCount, index);
    if (typeof item.question !== 'string' || !Array.isArray(item.evidenceIds) || !item.evidenceIds.every((id) => typeof id === 'string')) fail('invalid-item-shape', questionCount, index);
    bySlot.set(item.slotId, item);
  });
  for (const [index, slot] of blueprint.slots.entries()) if (!bySlot.has(slot.slotId)) fail('missing-slot-id', questionCount, index);

  const slotErrors = [];
  const questions = blueprint.slots.map((slot, index) => {
    try {
    const item = bySlot.get(slot.slotId);
    const cleanQuestion = normalizeSpokenQuestion(item.question);
    if (!cleanQuestion || cleanQuestion.length > MAX_QUESTION_LENGTH || !cleanQuestion.endsWith('?')) {
      fail('empty-or-oversized-field', questionCount, index);
    }
    const key = duplicateKey(cleanQuestion);
    if (seen.has(key)) fail('duplicate-question', questionCount, index);
    const contentTokens = new Set(words(cleanQuestion).filter((word) => !connectors.has(word)));
    for (const previous of seen) {
      const previousTokens = previous.split(' ');
      const overlap = previousTokens.filter((word) => contentTokens.has(word)).length;
      const similarity = overlap / Math.max(contentTokens.size, previousTokens.length, 1);
      if (similarity >= 0.86) fail('duplicate-question', questionCount, index);
    }
    if (options.previousQuestions?.some((previous) => previousQuestionMatches(cleanQuestion, previous))) {
      fail('previously-asked-question', questionCount, index);
    }
    if (category.id === 'technical_concepts') {
      const qualityIssue = validateTechnicalQuestion(cleanQuestion, slot, blueprint, resumeContext);
      if (qualityIssue) fail(qualityIssue, questionCount, index);
      const signature = makeCoverageSignature(slot.primaryAssessmentTarget, slot.subtopic, slot.assessmentObjective);
      if (slot.coverageSignature && slot.coverageSignature !== signature) fail('invalid-assessment-metadata', questionCount, index);
      if (list(options.previousAssessments).some((entry) => entry?.coverageSignature &&
          entry.coverageSignature === slot.coverageSignature)) fail('previously-assessed-objective', questionCount, index);
    }
    seen.add([...contentTokens].sort().join(' '));

    const suppliedEvidenceIds = [...new Set(item.evidenceIds)];
    if (suppliedEvidenceIds.length !== item.evidenceIds.length || suppliedEvidenceIds.some((id) => !validEvidenceIds.has(id))) {
      fail('invalid-evidence-reference', questionCount, index);
    }
    const expectedEvidenceId = slot.evidence.id;
    if (expectedEvidenceId && category.id !== 'behavioral_collaboration' &&
        (suppliedEvidenceIds.length !== 1 || suppliedEvidenceIds[0] !== expectedEvidenceId)) fail('invalid-evidence-reference', questionCount, index);
    if (category.id === 'behavioral_collaboration' && suppliedEvidenceIds.some((id) => id !== expectedEvidenceId)) fail('invalid-evidence-reference', questionCount, index);

    if (!provenanceIsValid(slot, resumeContext)) fail('invalid-evidence-provenance', questionCount, index);
    // Category intent is supplied by the selected category and the server-owned
    // blueprint slot order in the generation prompt. Do not reject a question
    // based on trigger words or narrow wording patterns: natural paraphrases and
    // both past-experience and hypothetical collaboration questions are valid.
    if (['domain_fundamentals', 'technical_concepts', 'project_deep_dive', 'professional_experience', 'applied_scenarios'].includes(category.id)) {
      // Required skills can guide fundamentals, technical-concept, and hypothetical
      // scenario questions. They cannot be used to imply prior project or job experience.
      const allowRequiredSkills = ['domain_fundamentals', 'technical_concepts', 'applied_scenarios'].includes(category.id);
      const unsupportedTechnology = hasUnsupportedTechnology(cleanQuestion, resumeContext, { allowRequiredSkills });
      // Technical questions assess knowledge, not past resume experience.
      // "How does PyTorch compare with TensorFlow?" must be allowed when
      // PyTorch is required, even if TensorFlow is not on the candidate's CV.
      // "How did you use TensorFlow in your project?" is still a false claim.
      if (unsupportedTechnology && (category.id !== 'technical_concepts' ||
          allegesUndocumentedTechnologyExperience(cleanQuestion, unsupportedTechnology))) {
        fail('unsupported-technology', questionCount, index);
      }
    }
    if (category.id === 'professional_experience' && hasUnsupportedExperienceEntity(cleanQuestion, resumeContext)) {
      fail('unsupported-past-claim', questionCount, index);
    }
    // Project and role evidence are attached from the server-side blueprint.
    // Do not require a project name or job title to be repeated in every spoken question.
    // Applied scenarios are hypothetical role situations. Their evidence link is
    // carried by the validated evidence ID; forcing every sentence to repeat a
    // tool name makes the interview sound artificial. Unsupported tools are
    // still rejected by hasUnsupportedTechnology above.
    const metric = cleanQuestion.match(/\b\d+(?:\.\d+)?\s*(?:%|percent|users?|requests?|ms|milliseconds?|seconds?|minutes?|hours?|records?|transactions?)\b/i)?.[0];
    if (metric && !containsPhrase(contextData(resumeContext).projects.map((project) => project.description).join(' '), metric) &&
        !containsPhrase(contextData(resumeContext).experience.flatMap((entry) => entry.responsibilities).join(' '), metric)) {
      fail('unsupported-past-claim', questionCount, index);
    }
    return {
      question: cleanQuestion,
      categoryId: category.id,
      slotId: slot.slotId,
      type: category.legacyType,
      basedOn: shortAnchor(slot.evidence.anchor, MAX_BASED_ON_LENGTH),
      evidenceIds: suppliedEvidenceIds,
      evidenceProvenance: { ...slot.evidence.provenance },
      ...(category.id === 'technical_concepts' ? {
        ...(slot.primaryRequiredSkill ? { primaryRequiredSkill: slot.primaryRequiredSkill } : {}),
        ...(slot.primaryResumeSkill ? { primaryResumeSkill: slot.primaryResumeSkill } : {}),
        primaryAssessmentTarget: slot.primaryAssessmentTarget,
        relatedRequiredSkills: list(slot.relatedRequiredSkills).slice(),
        subtopic: slot.subtopic,
        assessmentObjective: slot.assessmentObjective,
        questionStyle: slot.questionStyle,
        difficulty: slot.difficulty,
        assessmentCriteria: list(slot.assessmentCriteria).slice(),
        skillKind: slot.skillKind,
        skillConfidence: slot.skillConfidence,
        assessmentProvenance: slot.assessmentProvenance,
        coverageSignature: slot.coverageSignature,
        coverageFallback: slot.coverageFallback,
      } : {}),
    };
    } catch (error) {
      if (!options.collectErrors || error.questionIndex !== index) throw error;
      slotErrors.push({ questionIndex: index, code: error.code });
      return null;
    }
  });
  if (slotErrors.length) return { questions, errors: slotErrors };
  return questions;
}

module.exports = { validateGeneratedQuestions, validateGeneratedCategoryQuestions };
