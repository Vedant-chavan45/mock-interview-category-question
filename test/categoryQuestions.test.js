'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');
const { QUESTION_CATEGORIES, QUESTION_COUNT_PER_CATEGORY, getQuestionCategory } = require('../src/services/questionCategories');
const { buildCategoryBlueprint, categoryEvidencePreflight } = require('../src/services/categoryBlueprintService');
const { buildCategoryQuestionPrompt, generateCategoryQuestions, heuristicFallbackCategoryQuestions } = require('../src/services/questionGeneratorService');
const { validateGeneratedCategoryQuestions, validateGeneratedQuestions } = require('../src/services/questionValidatorService');
const { buildInterviewPlan } = require('../src/services/interviewPlannerService');
const { heuristicFallbackQuestions } = require('../src/services/questionGeneratorService');
const { rotationForCategory } = require('../src/services/questionRotationService');

const context = {
  targetRole: 'Backend Developer', interviewType: 'Technical',
  skills: ['Node.js', 'MongoDB'],
  projects: [
    { title: 'Nexus Messaging Platform', technologies: ['Express', 'Socket.io'], description: 'Built JWT authentication and real-time messaging.' },
    { title: 'Resume Parser Platform', technologies: ['Node.js', 'MongoDB'], description: 'Parsed resume text and exposed structured resume data through REST APIs.' },
  ],
  experience: [{ role: 'Developer Intern', organisation: 'Elastik Teams', responsibilities: [
    'Resolved database query issues.', 'Designed REST APIs.',
  ] }],
  education: [{ degree: 'B.Tech', institution: 'Example University', year: '2026' }],
};
const plan = buildInterviewPlan(context);
const categoryIds = Object.keys(QUESTION_CATEGORIES);

function parsePromptJson(prompt, marker, endMarker) {
  const markerIndex = prompt.indexOf(marker);
  assert.notEqual(markerIndex, -1, `Prompt is missing its expected JSON marker: ${prompt.slice(0, 700)}`);
  const start = markerIndex + marker.length;
  const end = endMarker ? prompt.indexOf(endMarker, start) : -1;
  return JSON.parse(prompt.slice(start, end < 0 ? undefined : end).trim());
}

function technicalPlanFor(skills) {
  return { skillPlans: skills.map((name) => ({ kind: /node|mongodb|express/i.test(name) ? 'tool' : 'other', confidence: 0.8,
    interpretation: `${name} domain mechanisms`, subtopics: [0, 1, 2].map((index) => ({
      name: `${name} domain concept ${index + 1}`,
      keyTerms: [`${name} mechanism`, `state${index + 1}`, `boundary${index + 1}`],
      angles: [0, 1].map((angle) => ({ objective: `reason about ${name} domain concept ${index + 1} angle ${angle + 1}`,
        style: angle ? 'debugging' : 'mechanism', assessmentCriteria: ['Explain the mechanism', 'Connect it to an observable result'] })),
    })) })) };
}

function technicalQuestionResponse(prompt) {
  const targets = parsePromptJson(prompt, 'QUESTION OBJECTIVES IN ORDER (dynamic assessment blueprint): ', '\nPREVIOUS QUESTIONS');
  const forms = [
    (term, topic) => `When ${term} matters during ${topic}, what behavior should you expect and why?`,
    (term, topic) => `Given ${term} in ${topic}, what result would you predict at a boundary?`,
    (term, topic) => `How does ${term} affect ${topic} when the input changes?`,
    (term, topic) => `If ${term} behaves unexpectedly in ${topic}, where would you look first?`,
    (term, topic) => `Why does ${term} matter for ${topic}, and what observation would confirm it?`,
    (term, topic) => `What would change in ${topic} if ${term} had a different value?`,
  ];
  return { questions: targets.map((target, index) => {
    const term = target.keyTerms?.[0] || target.subtopic.split(' ')[0];
    return forms[index % forms.length](term, target.subtopic);
  }) };
}

function technicalRequestPayload(prompt) {
  if (prompt.startsWith('You are the technical assessment planner')) {
    const skills = parsePromptJson(prompt, 'TARGETS IN REQUIRED ORDER: ', '\nPRIOR COVERAGE');
    return technicalPlanFor(skills);
  }
  if (prompt.startsWith('Role ') && prompt.includes('QUESTION OBJECTIVES IN ORDER (dynamic assessment blueprint):')) return technicalQuestionResponse(prompt);
  if (prompt.startsWith('Independently review these six')) {
    const targets = parsePromptJson(prompt, 'ASSESSMENT PLAN AND QUESTIONS: ', '\nPREVIOUSLY ASSESSED');
    return { reviews: targets.map((target) => ({ slotId: target.slotId, targetAlignment: 5, technicalCoherence: 5,
      roleLevelFit: 5, spokenClarity: 5, objectiveUniqueness: 5, issueCodes: [] })) };
  }
  throw new Error(`Unexpected technical generation stage: ${prompt.slice(0, 64)}`);
}
const modelQuestions = {
  domain_fundamentals: [
    'When a request reaches your API, what would you check before handling it?',
    'What would you do if two users changed the same database record at once?',
    'How would you stop a user from opening a page they are not allowed to see?',
    'Your API becomes slow when more people use it. What would you check first?',
    'What would you check when two requests update the same record and one fails?',
    'How would you decide whether a new feature belongs in one part of the API or another?',
  ],
  technical_concepts: (() => {
    const slots = buildCategoryBlueprint(context, 'technical_concepts', plan).slots;
    return [
      `How would you use ${slots[0].evidence.anchor} to build a small feature for this role?`,
      `How does ${slots[1].evidence.anchor} work with the other parts of the application?`,
      `If a feature using ${slots[2].evidence.anchor} stops working, how would you find the cause?`,
      `What would you check if a feature using ${slots[3].evidence.anchor} became slow?`,
      `How would you check that data handled by ${slots[4].evidence.anchor} is correct and safe?`,
      `When would you choose ${slots[5].evidence.anchor} instead of another option?`,
    ];
  })(),
  project_deep_dive: [
    'What problem was Nexus Messaging Platform built to solve?',
    'Which part of this project did you build or handle yourself?',
    'Can you walk me through what happens when a user sends a message?',
    'Why did you choose this approach for the Resume Parser Platform?',
    'How did you test this project to make sure it worked?',
    'What would you improve first if you worked on this project again?',
  ],
  professional_experience: [
    'What was one responsibility you handled during your Developer Intern work?',
    'Can you give an example of a technical task you worked on as a Developer Intern?',
    'Tell me about a problem you faced during your Developer Intern work and how you fixed it?',
    'How did you plan and track tasks during your Developer Intern work?',
    'How did you check that a change worked as expected during your internship?',
    'What did you learn during your internship that changed how you work?',
  ],
  applied_scenarios: (() => {
    const slots = buildCategoryBlueprint(context, 'applied_scenarios', plan).slots;
    return [
      `Imagine your ${slots[0].evidence.anchor} API becomes slow. What would you check first?`,
      `Suppose a ${slots[1].evidence.anchor} query returns the wrong records. How would you investigate?`,
      `Imagine a page protected by ${slots[2].evidence.anchor} is open to the wrong user. What would you check?`,
      `If two users update the same ${slots[3].evidence.anchor} record, how would you avoid losing a change?`,
      `Suppose an integration using ${slots[4].evidence.anchor} breaks after a change. How would you find the cause?`,
      `Imagine a ${slots[5].evidence.anchor} service stops responding. What would you check first?`,
    ];
  })(),
  behavioral_collaboration: [
    'Tell me about a time you took responsibility for a task and finished it?',
    'Tell me about feedback you received and what you changed afterward?',
    'Tell me about a disagreement with a teammate and how you handled it?',
    'Can you share an example of explaining your work clearly or asking for help?',
    'Tell me about a mistake you made and what you learned from it?',
    'Tell me about a time you had two deadlines and how you decided what to do first?',
  ],
};

function modelResponse(categoryId, questions = modelQuestions[categoryId], targetContext = context) {
  const targetPlan = buildInterviewPlan(targetContext);
  const blueprint = buildCategoryBlueprint(targetContext, categoryId, targetPlan);
  return { questions: questions.map((question, index) => ({
    slotId: blueprint.slots[index].slotId,
    question,
    evidenceIds: blueprint.slots[index].evidence.id ? [blueprint.slots[index].evidence.id] : [],
  })) };
}

function metadataKeys(question) {
  return Object.keys(question).sort();
}

test('each category defines six unique, distinct, and meaningful slot objectives', () => {
  for (const categoryId of categoryIds.filter((id) => id !== 'technical_concepts')) {
    const blueprint = buildCategoryBlueprint(context, categoryId, plan);
    assert.equal(blueprint.slots.length, QUESTION_COUNT_PER_CATEGORY, categoryId);
    assert.equal(new Set(blueprint.slots.map((slot) => slot.slotId)).size, 6, categoryId);
    assert.equal(new Set(blueprint.slots.map((slot) => slot.objective)).size, 6, categoryId);
    assert.ok(blueprint.slots.every((slot) => slot.objective.length > 35 && slot.evidence.anchor));
    assert.ok(blueprint.slots.every((slot) => !Object.hasOwn(slot, 'intent')));
  }
  const technical = buildCategoryBlueprint(context, 'technical_concepts', plan);
  assert.equal(technical.slots.length, 6);
  assert.equal(new Set(technical.slots.map((slot) => slot.slotId)).size, 6);
  assert.ok(technical.slots.every((slot) => !slot.questionExample && /independently planned/.test(slot.objective)));
  assert.match(buildCategoryBlueprint(context, 'domain_fundamentals', plan).slots[0].objective, /API/);
  const fullStack = buildCategoryBlueprint({ ...context, targetRole: 'Full Stack Developer' }, 'domain_fundamentals');
  assert.match(fullStack.slots[0].objective, /browser|API/i);
  const systems = buildCategoryBlueprint({ ...context, targetRole: 'C++ Developer' }, 'domain_fundamentals');
  assert.match(systems.slots[0].objective, /memory|ownership/i);
});

test('role-specific category plans keep six valid interview examples across common engineering roles', () => {
  const roles = ['Backend Developer', 'Full Stack Developer', 'Frontend Developer', 'C++ Developer',
    'QA Engineer', 'Data Engineer', 'AI Engineer', 'Software Engineer'];
  const supportedEvidence = {
    skills: ['JavaScript', 'Node.js', 'MongoDB', 'Python', 'React', 'SQL', 'C++', 'Jest', 'Playwright', 'TensorFlow'],
    projects: [
      { title: 'Event Planner App', description: 'Built an event planning application with user sign-in and saved events.', technologies: ['Node.js', 'MongoDB', 'React'] },
      { title: 'Test Automation Suite', description: 'Automated browser tests and API checks.', technologies: ['Playwright', 'Jest'] },
    ],
    experience: [{ role: 'Software Intern', organisation: 'Example Labs', responsibilities: ['Built REST API endpoints', 'Wrote automated tests'] }],
  };
  let checked = 0;
  for (const targetRole of roles) {
    const roleContext = { ...supportedEvidence, targetRole, interviewType: 'Technical' };
    const rolePlan = buildInterviewPlan(roleContext);
    for (const categoryId of categoryIds.filter((id) => id !== 'technical_concepts')) {
      const result = heuristicFallbackCategoryQuestions(roleContext, categoryId, rolePlan);
      assert.equal(result.questions.length, 6, `${targetRole}:${categoryId}`);
      assert.equal(result.source, 'heuristic-fallback');
      checked += 1;
    }
  }
  assert.equal(checked, 40);
  assert.throws(() => heuristicFallbackCategoryQuestions({ ...supportedEvidence, targetRole: 'Backend Developer' },
    'technical_concepts', buildInterviewPlan({ ...supportedEvidence, targetRole: 'Backend Developer' })),
  { code: 'TECHNICAL_TEMPLATE_FALLBACK_DISABLED' });
});

test('category prompts contain the selected role, interview type, evidence, category, and ordered slot objectives', () => {
  for (const categoryId of categoryIds) {
    const prompt = buildCategoryQuestionPrompt(context, categoryId, plan);
    const blueprint = buildCategoryBlueprint(context, categoryId, plan);
    assert.match(prompt, /Role .*Backend Developer/);
    assert.match(prompt, /Technical/);
    assert.match(prompt, new RegExp(QUESTION_CATEGORIES[categoryId].label));
    assert.match(prompt, /RESUME EVIDENCE/);
    assert.match(prompt, /QUESTION OBJECTIVES IN ORDER/);
    if (categoryId === 'technical_concepts') {
      assert.match(prompt, /Resume skills are secondary context only/);
      assert.match(prompt, /required skill is not evidence/i);
      assert.match(prompt, /The broad skill label may be omitted/);
    }
    if (categoryId === 'applied_scenarios') assert.match(prompt, /Do not force a technology name into every Applied Scenario/i);
    for (const slot of blueprint.slots) {
      assert.ok(prompt.includes(slot.slotId), `${categoryId}:${slot.slotId}`);
      if (categoryId !== 'technical_concepts') assert.ok(slot.questionExample && prompt.includes(slot.questionExample), `${categoryId}:${slot.slotId}:questionExample`);
    }
    assert.match(prompt, /Return only \{"questions"/);
    if (categoryId !== 'technical_concepts') assert.match(prompt, /evidenceId/);
    assert.doesNotMatch(prompt, /basedOn|categoryId.*output/i);
  }
  assert.match(buildCategoryQuestionPrompt(context, 'project_deep_dive', plan), /Nexus Messaging Platform/);
  const projectPrompt = buildCategoryQuestionPrompt(context, 'project_deep_dive', plan);
  // Phase 2C intentionally removes forced project-name insertion. The evidence
  // cards must instead carry documented functionality and technologies, so
  // the model can ask meaningful implementation questions without name dropping.
  assert.match(projectPrompt, /"documentedProjectTitle":"Nexus Messaging Platform"/);
  assert.match(projectPrompt, /"documentedProjectTitle":"Resume Parser Platform"/);
  assert.match(projectPrompt, /"documentedFunctionality":"Built JWT authentication and real-time messaging/);
  assert.doesNotMatch(projectPrompt, /mentionProjectNameOnce/);
  const technicalPrompt = buildCategoryQuestionPrompt(context, 'technical_concepts', plan);
  assert.match(technicalPrompt, /QUESTION OBJECTIVES IN ORDER/);
  assert.doesNotMatch(technicalPrompt, /includeSkillName|must mention each skill exactly/i);
  const appliedPrompt = buildCategoryQuestionPrompt(context, 'applied_scenarios', plan);
  assert.doesNotMatch(appliedPrompt, /requiredEvidencePhrase|includeSkillName/);
  assert.match(buildCategoryQuestionPrompt(context, 'professional_experience', plan), /Developer Intern/);
  assert.match(buildCategoryQuestionPrompt(context, 'professional_experience', plan), /Elastik Teams/);
  assert.throws(() => buildCategoryQuestionPrompt(context, 'unsupported'), { code: 'invalid-category' });
  assert.equal(getQuestionCategory('toString'), null);
});

test('the category validator assigns metadata from slot order and accepts natural paraphrases', () => {
  for (const categoryId of categoryIds.filter((id) => id !== 'technical_concepts')) {
    const category = getQuestionCategory(categoryId);
    let result;
    try { result = validateGeneratedCategoryQuestions(modelResponse(categoryId), context, plan, category); }
    catch (error) { error.message = `${categoryId} ${error.code} ${error.questionIndex}`; throw error; }
    assert.equal(result.length, 6);
    assert.deepEqual(result.map((item) => item.slotId), buildCategoryBlueprint(context, categoryId, plan).slots.map((slot) => slot.slotId));
    assert.ok(result.every((item) => item.categoryId === categoryId && item.type === category.legacyType));
    assert.ok(result.every((item) => item.basedOn && item.evidenceProvenance?.kind));
    assert.ok(result.every((item) => metadataKeys(item).join(',') === 'basedOn,categoryId,evidenceIds,evidenceProvenance,question,slotId,type'));
  }
  assert.throws(() => validateGeneratedCategoryQuestions(modelResponse('technical_concepts'), context, plan,
    getQuestionCategory('technical_concepts')), (error) => error.code === 'off-target-subtopic');
  const paraphrases = modelQuestions.domain_fundamentals.slice();
  const assignedSkill = buildCategoryBlueprint(context, 'technical_concepts', plan).slots[0].evidence.anchor;
  paraphrases[0] = `How would you follow a ${assignedSkill} API call from its route through middleware and return a predictable response?`;
  assert.equal(validateGeneratedCategoryQuestions(modelResponse('domain_fundamentals', paraphrases), context, plan, getQuestionCategory('domain_fundamentals')).length, 6);
  const flexibleBehavioralWording = modelQuestions.behavioral_collaboration.slice();
  flexibleBehavioralWording[5] = "If you were working on a team project and one team member wasn't pulling their weight, how would you handle the situation?";
  const behavioralResult = validateGeneratedCategoryQuestions(modelResponse('behavioral_collaboration', flexibleBehavioralWording), context, plan,
    getQuestionCategory('behavioral_collaboration'));
  assert.equal(behavioralResult.length, 6);
  assert.equal(behavioralResult[5].slotId, 'communication_prioritization');
});


test('validates natural live Ollama wording across all six categories and normalizes spoken prompt punctuation', () => {
  const fixture = require('./fixtures/syntheticInterviewResume');
  const contextBuilder = require('../src/services/contextBuilder');
  const liveContext = contextBuilder.build(fixture.parsedResume, fixture.analysis, {
    targetRole: fixture.targetRole, interviewType: fixture.interviewType,
  });
  const livePlan = buildInterviewPlan(liveContext);

  const domainQuestions = [
    'What would you check first when a user reports an issue with our API?',
    'How do you handle two updates to the same database record at once?',
    'How would you make sure a user only sees information they are allowed to access?',
    'How would you find why an API becomes slow when more people use it?',
    'What would you check when saving data to the database returns an error?',
    'How would you decide where a new feature should live in the application?',
  ];
  assert.equal(validateGeneratedCategoryQuestions(modelResponse('domain_fundamentals', domainQuestions, liveContext), liveContext, livePlan,
    getQuestionCategory('domain_fundamentals')).length, 6);

  const techSlots = buildCategoryBlueprint(liveContext, 'technical_concepts', livePlan).slots;
  const technical = [
    `How would you use ${techSlots[0].evidence.anchor} to build a small feature for this role?`,
    'How does Express handle HTTP requests and responses?',
    `If a feature using ${techSlots[2].evidence.anchor} stops working, how would you find the cause?`,
    `What would you check if a feature using ${techSlots[3].evidence.anchor} became slow?`,
    `How would you check that data handled by ${techSlots[4].evidence.anchor} is correct and safe?`,
    `When would you choose ${techSlots[5].evidence.anchor} instead of another option?`,
  ];
  assert.throws(() => validateGeneratedCategoryQuestions(modelResponse('technical_concepts', technical, liveContext), liveContext, livePlan,
    getQuestionCategory('technical_concepts')), (error) => error.code === 'generic-template-framing' || error.code === 'off-target-subtopic');

  const project = [
    "Can you explain how Synthetic Ticket Routing API works from a user's point of view?",
    'Which part of this project did you build or handle yourself?',
    'How does the API handle a support ticket from start to finish?',
    'Why did you choose this approach for Synthetic Inventory Service?',
    'How did you test this project before sharing it?',
    'What would you improve first in this project?',
  ];
  assert.equal(validateGeneratedCategoryQuestions(modelResponse('project_deep_dive', project, liveContext), liveContext, livePlan,
    getQuestionCategory('project_deep_dive')).length, 6);

  const experience = [
    'Tell me about a task you handled as a Backend Engineering Intern.',
    'What API change did you work on during your internship?',
    'Tell me about a problem you faced while investigating a database query.',
    'How did you coordinate API changes with other people?',
    'How did you check that your changes worked as expected?',
    'What did you learn from that experience?',
  ];
  const experienceResult = validateGeneratedCategoryQuestions(modelResponse('professional_experience', experience, liveContext), liveContext, livePlan,
    getQuestionCategory('professional_experience'));
  assert.equal(experienceResult.length, 6);
  assert.equal(experienceResult[0].question, 'Tell me about a task you handled as a Backend Engineering Intern?');

  const appliedSlots = buildCategoryBlueprint(liveContext, 'applied_scenarios', livePlan).slots;
  const applied = [
    `Suppose the ${appliedSlots[0].evidence.anchor} API becomes slow during busy hours. What would you check first?`,
    `Suppose a ${appliedSlots[1].evidence.anchor} query returns the wrong records. How would you investigate?`,
    'Suppose a user can access a sensitive API endpoint they should not. What would you check first?',
    'If two users update the same record, how would you avoid losing a change?',
    `Suppose a service using ${appliedSlots[4].evidence.anchor} fails after a change. How would you find the cause?`,
    `Imagine the ${appliedSlots[5].evidence.anchor} service stops responding. What would you check first?`,
  ];
  assert.equal(validateGeneratedCategoryQuestions(modelResponse('applied_scenarios', applied, liveContext), liveContext, livePlan,
    getQuestionCategory('applied_scenarios')).length, 6);

  const behavioral = [
    'Tell me about a time when you had to take ownership of a project and see it through to completion.',
    'Tell me about feedback you received and what you changed afterward?',
    'Tell me about a disagreement with a teammate and how you handled it?',
    'Tell me about a time you worked with a teammate to finish a task?',
    'Tell me about a mistake you made and what you learned from it?',
    'Tell me about a time you had two deadlines and how you decided what to do first?',
  ];
  const behavioralResult = validateGeneratedCategoryQuestions(modelResponse('behavioral_collaboration', behavioral, liveContext), liveContext, livePlan,
    getQuestionCategory('behavioral_collaboration'));
  assert.equal(behavioralResult.length, 6);
  assert.equal(behavioralResult[0].question, 'Tell me about a time when you had to take ownership of a project and see it through to completion?');
});

test('a natural peak-usage performance question generates for a backend role without slot-keyword repair', async (t) => {
  const liveContext = { ...context, targetRole: 'Backend Developer' };
  const performanceQuestion = 'What would you check first when an application slows down during peak usage?';
  const questions = modelQuestions.domain_fundamentals.slice();
  questions[3] = performanceQuestion;
  const request = t.mock.method(axios, 'post', async () => ({ status: 200, data: {
    response: JSON.stringify({ questions }),
  } }));

  const result = await generateCategoryQuestions(liveContext, 'domain_fundamentals', { force: true });
  assert.equal(result.status, 'ready');
  assert.equal(result.source, 'ollama-llama3.2');
  assert.equal(result.metrics.repairCount, 0);
  assert.equal(result.questions[3].question, performanceQuestion);
  assert.equal(request.mock.callCount(), 1);
});

test('the exact Behavioral teamwork question is accepted from Ollama without a wording-based repair', async (t) => {
  const liveContext = { ...context, targetRole: 'Backend Developer' };
  const question = "If you were working on a team project and one team member wasn't pulling their weight, how would you handle the situation?";
  const questions = modelQuestions.behavioral_collaboration.slice();
  questions[5] = question;
  const request = t.mock.method(axios, 'post', async () => ({ status: 200, data: {
    response: JSON.stringify({ questions }),
  } }));

  const result = await generateCategoryQuestions(liveContext, 'behavioral_collaboration', { force: true });
  assert.equal(result.status, 'ready');
  assert.match(result.source, /^ollama-/);
  assert.equal(result.metrics.repairCount, 0);
  assert.equal(result.questions[5].question, question);
  assert.equal(request.mock.callCount(), 1);
});

test('domain system-boundary slot accepts the exact natural 23-word question from the latest real-resume diagnostic', () => {
  const liveContext = { ...context, targetRole: 'Software Engineer' };
  const livePlan = buildInterviewPlan(liveContext);
  const questions = [
    'If you were building a new feature, how would you decide which part of the app should handle the task of user authentication?',
    'How would you keep data correct when two users update the same record?',
    'How would you check which users can access a feature?',
    'What would you check first when an application slows down during peak usage?',
    'If a feature stops working, how would you find the cause?',
    'How would you choose between two ways of building a feature?',
  ];

  const result = validateGeneratedCategoryQuestions(
    modelResponse('domain_fundamentals', questions, liveContext),
    liveContext,
    livePlan,
    getQuestionCategory('domain_fundamentals'),
  );

  assert.equal(result[0].slotId, 'system_boundaries');
  assert.equal(result[0].question, questions[0]);
  assert.equal(result[3].slotId, 'performance_constraints');
  assert.equal(result[3].question, 'What would you check first when an application slows down during peak usage?');
  assert.equal((questions[0].match(/\S+/g) || []).length, 23);
});

test('category validation accepts longer natural questions within the response size limit', () => {
  const liveContext = { ...context, targetRole: 'Software Engineer' };
  const livePlan = buildInterviewPlan(liveContext);
  const questions = [
    'Imagine you are building a new feature for an application and need to decide which part should handle user authentication and keep that logic separate from the other responsibilities in the application?',
    'How would you keep data correct when two users update the same record?',
    'How would you check which users can access a feature?',
    'An application becomes slow during busy hours. What would you check first?',
    'If a feature stops working, how would you find the cause?',
    'How would you choose between two ways of building a feature?',
  ];

  const validated = validateGeneratedCategoryQuestions(
    modelResponse('domain_fundamentals', questions, liveContext), liveContext, livePlan,
    getQuestionCategory('domain_fundamentals'),
  );
  assert.equal(validated.length, 6);
  assert.equal(validated[0].question, questions[0]);
});

test('latest live Ollama wording is accepted by category-level relevance checks', () => {
  const fixture = require('./fixtures/syntheticInterviewResume');
  const contextBuilder = require('../src/services/contextBuilder');
  const liveContext = contextBuilder.build(fixture.parsedResume, fixture.analysis, {
    targetRole: fixture.targetRole, interviewType: fixture.interviewType,
  });
  const livePlan = buildInterviewPlan(liveContext);

  const projectQuestions = [
    "Can you explain how Synthetic Ticket Routing API works from a user's point of view?",
    'Tell me about your role in building Synthetic Ticket Routing API.',
    'What happens in Synthetic Ticket Routing API when a user submits a new ticket?',
    'How did you choose to validate requests in Synthetic Inventory Service?',
    'Can you describe how you tested Synthetic Inventory Service for errors?',
    'What improvements would you make to Synthetic Inventory Service if you worked on it again?',
  ];
  assert.equal(validateGeneratedCategoryQuestions(modelResponse('project_deep_dive', projectQuestions, liveContext), liveContext, livePlan,
    getQuestionCategory('project_deep_dive')).length, 6);

  const experienceQuestions = [
    'Tell me about a task you handled as a Backend Engineering Intern.',
    'Can you explain how you investigated MongoDB query issues?',
    'Describe a real problem you faced while coordinating API changes.',
    'How did you coordinate API changes with other people?',
    'Tell me about a time when you had to verify changes with repeatable checks.',
    'What did you learn from working on a small synthetic project team?',
  ];
  assert.equal(validateGeneratedCategoryQuestions(modelResponse('professional_experience', experienceQuestions, liveContext), liveContext, livePlan,
    getQuestionCategory('professional_experience')).length, 6);

  const behavioralQuestions = [
    'Tell me about a time you took ownership of a project task.',
    'Can you explain how you handled feedback on your code?',
    'Describe a situation where you had to disagree with a teammate.',
    'Tell me about a project where you had to collaborate with others to meet a deadline.',
    'What did you do when you encountered a bug in your code?',
    'Can you walk me through how you prioritized tasks when working on a tight deadline?',
  ];
  assert.equal(validateGeneratedCategoryQuestions(modelResponse('behavioral_collaboration', behavioralQuestions, liveContext), liveContext, livePlan,
    getQuestionCategory('behavioral_collaboration')).length, 6);

  const applied = [
    'Suppose the API becomes slow during busy hours. What would you check first?',
    'If a database query returns incorrect results, how would you investigate?',
    'Suppose a user can access an API endpoint they should not. What would you check first?',
    'If two users update the same record, how would you avoid losing a change?',
    'Imagine a new service integration fails after a change. How would you find the cause?',
    'What would you do if a user reported that their data was being overwritten unexpectedly?',
  ];
  assert.equal(validateGeneratedCategoryQuestions(modelResponse('applied_scenarios', applied, liveContext), liveContext, livePlan,
    getQuestionCategory('applied_scenarios')).length, 6);
});

test('the previous live Ollama wording is not rejected for category phrasing; only malformed questions remain invalid', () => {
  const fixture = require('./fixtures/syntheticInterviewResume');
  const liveContext = require('../src/services/contextBuilder').build(fixture.parsedResume, fixture.analysis, {
    targetRole: fixture.targetRole, interviewType: fixture.interviewType,
  });
  const livePlan = buildInterviewPlan(liveContext);
  const loggedQuestions = {
    domain_fundamentals: [
      'If a user reports an issue with our API, what would you check first?',
      'Can you describe how you would ensure data consistency in a database when two updates happen at the same time?',
      'How would you verify that a user can only access the routes and information they are allowed to see?',
      'What steps would you take to identify why an API becomes slow when more people start using it?',
      'How would you handle an error when two requests try to change the same record at the same time?',
      'Can you explain why you would choose a particular approach to organize a feature in a project like this?',
    ],
    technical_concepts: [
      'How would you use MongoDB to build a small feature and check that it works?',
      'How do you connect Express to MongoDB in a real-world application?',
      "What's the best way to handle JWT authentication failures in a Node.js project?",
      'Can you explain how Node.js handles performance optimization?',
      'How do you ensure security when using REST APIs in a backend?',
      'How would you choose between using MongoDB and another NoSQL database for a specific project?',
    ],
    project_deep_dive: [
      "Can you explain how Synthetic Ticket Routing API works from a user's point of view?",
      'Tell me about your role in building Synthetic Ticket Routing API.',
      'What happens in Synthetic Ticket Routing API when a user submits a new ticket?',
      'How did you choose to validate requests in Synthetic Ticket Routing API?',
      'Can you describe how you tested Synthetic Ticket Routing API for errors?',
      'What improvements would you make to Synthetic Inventory Service if you worked on it again?',
    ],
    professional_experience: [
      'Tell me about a task you handled as a Backend Engineering Intern.',
      'Can you explain how you investigated MongoDB query issues?',
      'Describe a real problem you faced while coordinating API changes.',
      'How did you implement REST endpoints and request validation?',
      'Tell me about a time when you had to verify changes with repeatable checks.',
      'What did you learn from working on a small synthetic project team?',
    ],
    applied_scenarios: [
      'Suppose the API becomes slow during busy hours. What would you check first?',
      'If a database query is returning incorrect results. What would you check first?',
      'A user cannot access an endpoint they should be allowed to use. What would you check first?',
      'Describe how you would implement access control for a REST API. What security measures would you take?',
      'If you were to integrate a new service with our existing backend. What steps would you take to ensure a smooth integration?',
      'What would you do if a user reported that their data was being overwritten unexpectedly?',
    ],
    behavioral_collaboration: [
      'Tell me about a time you took ownership of a project task?',
      'Can you explain how you handled feedback on your code?',
      'Describe a situation where you had to disagree with a teammate.',
      'Tell me about a project where you had to collaborate with others to meet a deadline.',
      'What did you do when you encountered a bug in your code?',
      'Can you walk me through how you prioritized tasks when working on a tight deadline?',
    ],
  };
  const expectedErrorIndexes = {
    domain_fundamentals: [],
    technical_concepts: [0, 1, 2, 3, 4, 5],
    project_deep_dive: [],
    professional_experience: [],
    applied_scenarios: [],
    behavioral_collaboration: [],
  };
  for (const [categoryId, questions] of Object.entries(loggedQuestions)) {
    const blueprint = buildCategoryBlueprint(liveContext, categoryId, livePlan);
    const result = validateGeneratedCategoryQuestions({ questions }, liveContext, livePlan,
      getQuestionCategory(categoryId), blueprint, { collectErrors: true });
    assert.deepEqual((result.errors || []).map((error) => error.questionIndex), expectedErrorIndexes[categoryId], categoryId);
  }
});

test('all six category slots provide practical spoken examples across supported engineering roles', () => {
  const roles = ['Backend Developer', 'Full Stack Developer', 'Frontend Developer', 'C++ Developer',
    'QA Engineer', 'Data Engineer', 'AI Engineer', 'Software Engineer'];
  const roleContext = {
    skills: ['Node.js', 'Express', 'MongoDB', 'JWT', 'REST APIs', 'React', 'SQL', 'Python', 'Jest', 'C++', 'Playwright'],
    projects: [{ title: 'Example Project', description: 'Built a service and tested its API.', technologies: ['Node.js', 'MongoDB'] }],
    experience: [{ role: 'Developer Intern', responsibilities: ['Built API endpoints', 'Coordinated work with a team'] }],
  };
  for (const targetRole of roles) {
    for (const categoryId of categoryIds) {
      const blueprint = buildCategoryBlueprint({ ...roleContext, targetRole }, categoryId);
      assert.equal(blueprint.slots.length, 6);
      if (categoryId === 'technical_concepts') {
        assert.ok(blueprint.slots.every((slot) => /^technical_assessment_\d$/.test(slot.slotId) && !slot.questionExample),
          `${targetRole}:${categoryId}`);
      } else {
        assert.ok(blueprint.slots.every((slot) => typeof slot.questionExample === 'string' && slot.questionExample.endsWith('?')),
          `${targetRole}:${categoryId}`);
      }
    }
  }
});

test('Applied Scenarios accepts a direct scenario without requiring If, Suppose, or Imagine', () => {
  const fixture = require('./fixtures/syntheticInterviewResume');
  const liveContext = require('../src/services/contextBuilder').build(fixture.parsedResume, fixture.analysis, {
    targetRole: fixture.targetRole, interviewType: fixture.interviewType,
  });
  const livePlan = buildInterviewPlan(liveContext);
  const questions = [
    'Suppose the API becomes slow during busy hours. What would you check first?',
    'If a database query returns incorrect results, how would you investigate?',
    'A user can access an API endpoint they should not. What would you check first?',
    'If two users update the same record, how would you avoid losing a change?',
    'Imagine a new service integration fails after a change. How would you find the cause?',
    'What would you do if a user reported that their data was being overwritten unexpectedly?',
  ];
  const validated = validateGeneratedCategoryQuestions(modelResponse('applied_scenarios', questions, liveContext), liveContext, livePlan,
    getQuestionCategory('applied_scenarios'));
  assert.equal(validated.length, 6);
  assert.equal(validated[2].slotId, 'access_control_failure');
});

test('category validation does not police wording, opening phrases, word count, or sentence style', () => {
  const variedWording = modelQuestions.domain_fundamentals.slice();
  variedWording[0] = 'Could you provide a comprehensive explanation of how requests move through the API and why you would choose that approach for a new feature?';
  variedWording[1] = 'Have you ever had to decide which part of an application should handle authentication for a new feature.';
  variedWording[4] = 'If a database query returns incorrect results. What would you check first?';
  variedWording[5] = 'How would you organize a feature, and why would you choose that design?';

  const validated = validateGeneratedCategoryQuestions(modelResponse('domain_fundamentals', variedWording), context, plan,
    getQuestionCategory('domain_fundamentals'));
  assert.equal(validated.length, 6);
  assert.equal(validated[0].question, variedWording[0]);
  assert.equal(validated[1].question, 'Have you ever had to decide which part of an application should handle authentication for a new feature?');
  assert.equal(validated[4].question, variedWording[4]);
  assert.equal(validated[5].question, variedWording[5]);

  const abstractPerformance = modelQuestions.technical_concepts.slice();
  abstractPerformance[3] = `Can you explain how ${buildCategoryBlueprint(context, 'technical_concepts', plan).slots[3].evidence.anchor} handles performance optimization?`;
  assert.throws(() => validateGeneratedCategoryQuestions(modelResponse('technical_concepts', abstractPerformance), context, plan,
    getQuestionCategory('technical_concepts')), (error) => error.code === 'off-target-subtopic');
});

test('Role & Domain Fundamentals does not introduce tools absent from the resume', () => {
  const inventedTool = modelQuestions.domain_fundamentals.slice();
  inventedTool[0] = 'How would you add a Redis cache to this API?';
  assert.throws(() => validateGeneratedCategoryQuestions(modelResponse('domain_fundamentals', inventedTool), context, plan,
    getQuestionCategory('domain_fundamentals')), (error) => error.code === 'unsupported-technology' && error.questionIndex === 0);
});

test('Project Deep Dive can refer naturally to this project without repeating the title in each exact slot', () => {
  const result = validateGeneratedCategoryQuestions(modelResponse('project_deep_dive'), context, plan,
    getQuestionCategory('project_deep_dive'));
  assert.ok(result.slice(0, 3).every((item) => item.basedOn === 'Nexus Messaging Platform'));
  assert.ok(result.slice(3).every((item) => item.basedOn === 'Resume Parser Platform'));
  assert.ok(result.every((item) => item.evidenceProvenance.kind === 'resume_project'));
  const wrongTitle = modelQuestions.project_deep_dive.slice();
  wrongTitle[0] = wrongTitle[0].replace('Nexus Messaging Platform', 'this project');
  assert.equal(validateGeneratedCategoryQuestions(modelResponse('project_deep_dive', wrongTitle), context, plan, getQuestionCategory('project_deep_dive')).length, 6);
});

test('experience slots map to actual work evidence and invite real past examples', () => {
  const result = validateGeneratedCategoryQuestions(modelResponse('professional_experience'), context, plan,
    getQuestionCategory('professional_experience'));
  assert.ok(result.every((item) => item.evidenceProvenance.kind === 'resume_experience'));
  assert.ok(result.every((item) => item.basedOn === 'Developer Intern at Elastik Teams'));
  const assumedTeamwork = modelQuestions.professional_experience.slice();
  assumedTeamwork[3] = 'Tell me about a time you worked with a teammate to finish a task?';
  assert.equal(validateGeneratedCategoryQuestions(modelResponse('professional_experience', assumedTeamwork), context, plan,
    getQuestionCategory('professional_experience')).length, 6);
  const naturalOwnership = modelQuestions.professional_experience.slice();
  naturalOwnership[0] = 'Can you describe a time you were responsible for a task as a Developer Intern?';
  assert.equal(validateGeneratedCategoryQuestions(modelResponse('professional_experience', naturalOwnership), context, plan,
    getQuestionCategory('professional_experience')).length, 6);
  const inventedEmployer = modelQuestions.professional_experience.slice();
  inventedEmployer[0] = 'Can you describe a responsibility you owned at Globex Labs in your Developer Intern role?';
  assert.throws(() => validateGeneratedCategoryQuestions(modelResponse('professional_experience', inventedEmployer), context, plan, getQuestionCategory('professional_experience')),
    (error) => error.code === 'unsupported-past-claim' && error.questionIndex === 0);
  const noWork = { targetRole: 'Backend Developer', skills: ['Node.js'], projects: context.projects };
  const blueprint = buildCategoryBlueprint(noWork, 'professional_experience');
  assert.ok(blueprint.slots.every((slot) => slot.supportingEvidence.practicalExperience));
  const prompt = buildCategoryQuestionPrompt(noWork, 'professional_experience');
  assert.match(prompt, /documentedPracticalProjects/);
  const fallback = heuristicFallbackCategoryQuestions(noWork, 'professional_experience');
  assert.ok(fallback.questions.every((item) => item.evidenceProvenance.practicalExperience));
});

test('applied scenario wording is flexible while unsupported technologies are still rejected', () => {
  const result = validateGeneratedCategoryQuestions(modelResponse('applied_scenarios'), context, plan,
    getQuestionCategory('applied_scenarios'));
  assert.ok(result.every((item) => item.evidenceProvenance.kind.startsWith('resume_')));
  const unsupported = modelQuestions.applied_scenarios.slice();
  unsupported[0] = 'Suppose a Redis API becomes slow under load; how would you trace the bottleneck and verify throughput?';
  assert.throws(() => validateGeneratedCategoryQuestions(modelResponse('applied_scenarios', unsupported), context, plan, getQuestionCategory('applied_scenarios')),
    (error) => error.code === 'unsupported-technology' && error.questionIndex === 0);
  const directScenario = modelQuestions.applied_scenarios.slice();
  directScenario[3] = 'Two users update the same record at once. How would you prevent one change being lost?';
  assert.equal(validateGeneratedCategoryQuestions(modelResponse('applied_scenarios', directScenario), context, plan,
    getQuestionCategory('applied_scenarios')).length, 6);
});

test('Behavioral & Collaboration accepts both real-example and hypothetical teamwork wording', () => {
  const result = validateGeneratedCategoryQuestions(modelResponse('behavioral_collaboration'), context, plan,
    getQuestionCategory('behavioral_collaboration'));
  assert.equal(result.length, 6);
  assert.ok(result.every((item) => item.type === 'behavioral'));
  const hypotheticalTeamwork = modelQuestions.behavioral_collaboration.slice();
  hypotheticalTeamwork[5] = "If you were working on a team project and one team member wasn't pulling their weight, how would you handle the situation?";
  const hypotheticalResult = validateGeneratedCategoryQuestions(modelResponse('behavioral_collaboration', hypotheticalTeamwork), context, plan,
    getQuestionCategory('behavioral_collaboration'));
  assert.equal(hypotheticalResult.length, 6);
  assert.equal(hypotheticalResult[5].question, hypotheticalTeamwork[5]);
  const naturalOwnership = modelQuestions.behavioral_collaboration.slice();
  naturalOwnership[0] = 'Tell me about a time you stepped up to manage a deliverable and followed through?';
  assert.equal(validateGeneratedCategoryQuestions(modelResponse('behavioral_collaboration', naturalOwnership), context, plan,
    getQuestionCategory('behavioral_collaboration')).length, 6);
  const peopleScenario = modelQuestions.behavioral_collaboration.slice();
  peopleScenario[5] = 'If a teammate is falling behind, how would you discuss priorities and keep the work moving?';
  assert.equal(validateGeneratedCategoryQuestions(modelResponse('behavioral_collaboration', peopleScenario), context, plan,
    getQuestionCategory('behavioral_collaboration')).length, 6);
});

test('project descriptions without an extracted title still support a grounded Project Deep Dive', () => {
  const untitledProjectContext = {
    targetRole: 'Backend Developer', interviewType: 'Technical', skills: ['Node.js'],
    projects: [{ description: 'Built an event booking API that lets users create and review events.', technologies: ['Node.js'] }],
  };
  const questions = [
    'What problem was this project built to solve?',
    'Which part of this project did you build yourself?',
    'Can you explain how data moves through this project?',
    'Why did you choose this approach for the project?',
    'How did you test this project before sharing it?',
    'What would you improve first in this project?',
  ];
  const blueprint = buildCategoryBlueprint(untitledProjectContext, 'project_deep_dive');
  assert.equal(categoryEvidencePreflight(blueprint), null);
  assert.equal(blueprint.hasProjects, true);
  assert.equal(validateGeneratedCategoryQuestions(modelResponse('project_deep_dive', questions, untitledProjectContext),
    untitledProjectContext, buildInterviewPlan(untitledProjectContext), getQuestionCategory('project_deep_dive')).length, 6);
});

test('Professional Experience does not invent teamwork when only individual project work is documented', () => {
  const projectOnlyContext = {
    targetRole: 'Backend Developer', interviewType: 'Technical', skills: ['Node.js', 'MongoDB'],
    projects: [
      { title: 'Event Planner App', description: 'Built an event planning API with user sign-in and saved events.', technologies: ['Node.js', 'MongoDB'] },
      { title: 'Test Automation Suite', description: 'Created browser tests and API checks for the application.', technologies: ['Playwright'] },
    ],
  };
  const questions = [
    'What responsibility did you take while building Event Planner App?',
    'Can you give an example of a feature you built for this project?',
    'Tell me about a problem you faced while working on this project?',
    'How did you plan and track tasks while working on Test Automation Suite?',
    'How did you test this project and check the result?',
    'What did you learn while working on this project?',
  ];
  const blueprint = buildCategoryBlueprint(projectOnlyContext, 'professional_experience');
  assert.equal(categoryEvidencePreflight(blueprint), null);
  assert.equal(blueprint.hasExperience, false);
  assert.equal(blueprint.hasPracticalExperience, true);
  assert.equal(blueprint.slots[3].supportingEvidence.collaborationDocumented, false);
  assert.match(buildCategoryQuestionPrompt(projectOnlyContext, 'professional_experience'), /without assuming teammates/i);
  const validated = validateGeneratedCategoryQuestions(modelResponse('professional_experience', questions, projectOnlyContext),
    projectOnlyContext, buildInterviewPlan(projectOnlyContext), getQuestionCategory('professional_experience'));
  assert.equal(validated.length, 6);
  const fallback = heuristicFallbackCategoryQuestions(projectOnlyContext, 'professional_experience');
  assert.match(fallback.questions[3].question, /plan and track your tasks/i);
});


test('Behavioral category does not assume a formal team when the resume shows individual work only', () => {
  const individualContext = {
    targetRole: 'Backend Developer', interviewType: 'Technical', skills: ['Node.js', 'MongoDB'],
    projects: [
      { title: 'Personal Task API', description: 'Built a personal task API with login and saved tasks.', technologies: ['Node.js', 'MongoDB'] },
    ],
  };
  const questions = modelQuestions.behavioral_collaboration.slice();
  questions[3] = 'Can you share an example of explaining your work clearly or asking for help?';
  const blueprint = buildCategoryBlueprint(individualContext, 'behavioral_collaboration');
  assert.equal(blueprint.slots[3].supportingEvidence.collaborationDocumented, false);
  assert.match(blueprint.slots[3].objective, /without assuming a formal team/i);
  const validated = validateGeneratedCategoryQuestions(modelResponse('behavioral_collaboration', questions, individualContext),
    individualContext, buildInterviewPlan(individualContext), getQuestionCategory('behavioral_collaboration'));
  assert.equal(validated.length, 6);
  const fallback = heuristicFallbackCategoryQuestions(individualContext, 'behavioral_collaboration');
  assert.match(fallback.questions[3].question, /explaining your work clearly or asking for help/i);
  assert.doesNotMatch(fallback.questions[3].question, /teammate/i);
  assert.match(buildCategoryQuestionPrompt(individualContext, 'behavioral_collaboration'), /without assuming a formal team/i);
});

test('applied scenario questions may use natural role language without repeating a technology in every question', () => {
  const naturalQuestions = [
    'Suppose an API becomes slow during busy hours. What would you check first?',
    'Suppose a database query returns the wrong records. How would you find the cause?',
    'Suppose a protected route ignores its permission check. What would you check?',
    'Suppose two users update the same record. How would you avoid losing a change?',
    'Suppose one part of an app breaks after a change. How would you find the cause?',
    'Suppose an important service stops responding. What would you check first?',
  ];
  const validated = validateGeneratedCategoryQuestions(modelResponse('applied_scenarios', naturalQuestions), context, plan,
    getQuestionCategory('applied_scenarios'));
  assert.equal(validated.length, 6);
  assert.ok(validated.every((item) => item.evidenceIds.length === 1));
});

test('missing project, experience, or skill evidence is reported without calling Ollama or presenting sample questions', async (t) => {
  const post = t.mock.method(axios, 'post', async () => { throw new Error('No model call expected without grounding evidence'); });
  const empty = { targetRole: '', interviewType: 'Technical', skills: [], projects: [], experience: [] };
  for (const categoryId of ['project_deep_dive', 'professional_experience', 'technical_concepts']) {
    await assert.rejects(generateCategoryQuestions(empty, categoryId), { code: 'INSUFFICIENT_RESUME_EVIDENCE' });
  }
  assert.equal(post.mock.callCount(), 0);
});

test('category model requests six concise question strings and application code assigns slots and evidence metadata', async (t) => {
  const calls = [];
  const request = t.mock.method(axios, 'post', async (_url, body) => {
    calls.push(body.prompt);
    if (body.prompt.startsWith('You are the technical assessment planner')) {
      assert.equal(body.format.properties.skillPlans.minItems, 2);
      return { status: 200, data: { response: JSON.stringify(technicalRequestPayload(body.prompt)) } };
    }
    if (body.prompt.startsWith('Role ') && body.prompt.includes('QUESTION OBJECTIVES IN ORDER (dynamic assessment blueprint):')) {
      assert.equal(body.format.properties.questions.minItems, 6);
      assert.equal(body.format.properties.questions.maxItems, 6);
      assert.equal(body.format.properties.questions.items.type, 'string');
      assert.equal(body.format.properties.questions.items.maxLength, 240);
      assert.match(body.prompt, /Return only \{"questions":\[/);
      return { status: 200, data: { response: JSON.stringify(technicalRequestPayload(body.prompt)) } };
    }
    assert.ok(body.prompt.startsWith('Independently review these six'));
    return { status: 200, data: { response: JSON.stringify(technicalRequestPayload(body.prompt)) } };
  });
  const result = await generateCategoryQuestions(context, 'technical_concepts', { force: true });
  assert.equal(request.mock.callCount(), 3);
  assert.equal(calls.length, 3);
  assert.equal(result.source, 'ollama-llama3.2');
  assert.equal(result.status, 'ready');
  assert.ok(result.questions.every((item, index) => item.slotId === buildCategoryBlueprint(context, 'technical_concepts', plan).slots[index].slotId));
  assert.ok(result.questions.every((item) => item.type === 'technical' && item.categoryId === 'technical_concepts'));
  assert.ok(result.questions.every((item) => item.evidenceIds.length === 1));
  assert.ok(result.questions.every((item) => item.subtopic && item.assessmentObjective && item.primaryResumeSkill));
});

test('each category accepts one valid mocked Ollama response and attributes AI only after validation', async (t) => {
  const calls = [];
  t.mock.method(axios, 'post', async (_url, body) => {
    if (body.prompt.startsWith('You are the technical assessment planner')) {
      calls.push('technical_concepts');
      return { status: 200, data: { response: JSON.stringify(technicalRequestPayload(body.prompt)) } };
    }
    if (body.prompt.startsWith('Role ') && body.prompt.includes('QUESTION OBJECTIVES IN ORDER (dynamic assessment blueprint):')) {
      calls.push('technical_concepts');
      return { status: 200, data: { response: JSON.stringify(technicalRequestPayload(body.prompt)) } };
    }
    if (body.prompt.startsWith('Independently review these six')) {
      calls.push('technical_concepts');
      return { status: 200, data: { response: JSON.stringify(technicalRequestPayload(body.prompt)) } };
    }
    const categoryId = categoryIds.find((id) => body.prompt.includes(`category ${id} (`)) || categoryIds.find((id) => body.prompt.includes(id));
    assert.ok(categoryId);
    calls.push(categoryId);
    return { status: 200, data: { response: JSON.stringify({ questions: modelQuestions[categoryId] }) } };
  });
  const results = [];
  for (const categoryId of categoryIds) results.push(await generateCategoryQuestions(context, categoryId, { force: true }));
  assert.deepEqual(calls, categoryIds.flatMap((id) => id === 'technical_concepts' ? [id, id, id] : [id]));
  assert.ok(results.every((result) => result.source === 'ollama-llama3.2' && result.questions.length === 6));
  for (const [index, categoryId] of categoryIds.entries()) {
    assert.equal(results[index].category, categoryId);
    assert.ok(results[index].questions.every((question) => question.categoryId === categoryId));
  }
});

test('response parsing rejects malformed JSON, missing slots, duplicate questions, and forged evidence IDs', async (t) => {
  const category = getQuestionCategory('domain_fundamentals');
  assert.throws(() => validateGeneratedCategoryQuestions({}, context, plan, category), { code: 'invalid-envelope' });
  const missing = modelResponse('domain_fundamentals');
  missing.questions.pop();
  assert.throws(() => validateGeneratedCategoryQuestions(missing, context, plan, category), { code: 'wrong-question-count' });
  const duplicate = modelResponse('domain_fundamentals');
  duplicate.questions[1].question = duplicate.questions[0].question;
  assert.throws(() => validateGeneratedCategoryQuestions(duplicate, context, plan, category),
    (error) => error.code === 'duplicate-question' && error.questionIndex === 1);
  const forgedEvidence = modelResponse('domain_fundamentals');
  forgedEvidence.questions[0].evidenceIds = ['resume_owner_secret'];
  assert.throws(() => validateGeneratedCategoryQuestions(forgedEvidence, context, plan, category),
    (error) => error.code === 'invalid-evidence-reference' && error.questionIndex === 0);

  t.mock.method(axios, 'post', async () => ({ status: 200, data: { response: '{"questions": [broken' } }));
  await assert.rejects(generateCategoryQuestions({ ...context, targetRole: 'Malformed Fixture Role' }, 'domain_fundamentals', { force: true }), SyntaxError);
});

test('slot IDs, rather than model ordering, control application-owned metadata', () => {
  const result = modelResponse('domain_fundamentals');
  result.questions.reverse();
  const validated = validateGeneratedCategoryQuestions(result, context, plan, getQuestionCategory('domain_fundamentals'));
  assert.deepEqual(validated.map((item) => item.slotId), buildCategoryBlueprint(context, 'domain_fundamentals', plan).slots.map((slot) => slot.slotId));
});

test('successful category responses expose Ollama timings and cache by role, evidence, category, model, and prompt version', async (t) => {
  const cachedContext = { ...context, targetRole: 'Cache Identity Fixture Role' };
  const request = t.mock.method(axios, 'post', async () => ({ status: 200, data: {
    response: JSON.stringify({ questions: modelQuestions.behavioral_collaboration }),
    done: true, total_duration: 800000000, load_duration: 100000000,
    prompt_eval_duration: 200000000, eval_duration: 450000000,
    prompt_eval_count: 321, eval_count: 87,
  } }));
  const first = await generateCategoryQuestions(cachedContext, 'behavioral_collaboration', { force: true });
  assert.equal(first.metrics.modelLoadMs, 100);
  assert.equal(first.metrics.promptEvalMs, 200);
  assert.equal(first.metrics.outputGenerationMs, 450);
  assert.equal(first.metrics.promptTokens, 321);
  assert.equal(first.metrics.outputTokens, 87);
  const second = await generateCategoryQuestions(cachedContext, 'behavioral_collaboration');
  assert.equal(second.metrics.cacheHit, true);
  assert.equal(request.mock.callCount(), 1);
  await generateCategoryQuestions(cachedContext, 'behavioral_collaboration', { force: true });
  assert.equal(request.mock.callCount(), 2);
});

test('one Ollama category request runs at a time even when callers request different categories', async (t) => {
  let active = 0;
  let maximumActive = 0;
  t.mock.method(axios, 'post', async (_url, body) => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    const categoryId = categoryIds.find((id) => body.prompt.includes(`category ${id} (`));
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
    return { status: 200, data: { response: JSON.stringify({ questions: modelQuestions[categoryId] }) } };
  });
  await Promise.all([
    generateCategoryQuestions(context, 'domain_fundamentals', { force: true }),
    generateCategoryQuestions(context, 'behavioral_collaboration', { force: true }),
  ]);
  assert.equal(maximumActive, 1);
});

test('a malformed slot gets one targeted repair; a rejected repair never becomes a ready fallback', async (t) => {
  const previous = process.env.DEBUG_QUESTION_GENERATION;
  process.env.DEBUG_QUESTION_GENERATION = '1';
  t.after(() => {
    if (previous === undefined) delete process.env.DEBUG_QUESTION_GENERATION;
    else process.env.DEBUG_QUESTION_GENERATION = previous;
  });
  const log = t.mock.method(console, 'error', () => {});
  const output = modelQuestions.behavioral_collaboration.slice();
  output[5] = '';
  const repairedResponse = modelResponse('behavioral_collaboration').questions[5];
  const request = t.mock.method(axios, 'post', async (_url, body) => ({ status: 200, data: { response: JSON.stringify(
    body.prompt.startsWith('Repair 1 invalid') ? { questions: [repairedResponse.question] } : { questions: output }) } }));
  const result = await generateCategoryQuestions(context, 'behavioral_collaboration', { force: true });
  assert.equal(result.source, 'ollama-llama3.2');
  assert.equal(result.status, 'ready');
  assert.equal(result.metrics.repairCount, 1);
  assert.equal(result.questions.length, 6);
  assert.equal(request.mock.callCount(), 2);
  assert.match(log.mock.calls.find((call) => /stage=validation-failed/.test(call.arguments[0])).arguments[0],
    /categoryId=behavioral_collaboration .*questionIndex=5 slotId=communication_prioritization/);
  assert.ok(log.mock.calls.some((call) => /categoryId=behavioral_collaboration .*validation=failed questionIndex=5 slotId=communication_prioritization/.test(call.arguments[0])));
  assert.ok(log.mock.calls.some((call) => /categoryId=behavioral_collaboration .*httpStatus=200 completion=done .*completedStream=true/.test(call.arguments[0])));
  assert.ok(log.mock.calls.some((call) => /categoryId=behavioral_collaboration .*httpStatus=200 .*questionCount=6 .*jsonParsed=true/.test(call.arguments[0])));
  assert.ok(log.mock.calls.some((call) => /categoryId=behavioral_collaboration .*validation=failed questionIndex=5 slotId=communication_prioritization/.test(call.arguments[0])));
  assert.ok(log.mock.calls.every((call) => !/Nexus Messaging Platform|Elastik Teams|structured resume|private/i.test(call.arguments[0])));
});

test('an invalid targeted repair is rejected after one attempt with its actual invalid slot available for diagnostics', async (t) => {
  const output = modelQuestions.behavioral_collaboration.slice();
  output[5] = '';
  const invalidRepair = output[5];
  const request = t.mock.method(axios, 'post', async (_url, body) => ({ status: 200, data: { response: JSON.stringify(
    body.prompt.startsWith('Repair 1 invalid') ? { questions: [invalidRepair] } : { questions: output }) } }));
  await assert.rejects(generateCategoryQuestions({ ...context, targetRole: 'Rejected Repair Fixture' }, 'behavioral_collaboration', { force: true }),
    (error) => error.code === 'empty-or-oversized-field' && error.repairPerformed === true && error.rejectedQuestion === '');
  assert.equal(request.mock.callCount(), 2);
});

test('multiple invalid category slots are repaired together in one bounded Ollama request', async (t) => {
  const output = modelQuestions.applied_scenarios.slice();
  output[2] = '';
  output[3] = '';
  const repaired = [
    'Suppose a user can access an API endpoint they should not. What would you check first?',
    'If two users update the same record, how would you prevent one change being lost?',
  ];
  const request = t.mock.method(axios, 'post', async (_url, body) => ({ status: 200, data: { response: JSON.stringify(
    body.prompt.startsWith('Repair 2 invalid') ? { questions: repaired } : { questions: output }) } }));
  const result = await generateCategoryQuestions(context, 'applied_scenarios', { force: true });
  assert.equal(result.status, 'ready');
  assert.equal(result.source, 'ollama-llama3.2');
  assert.equal(result.metrics.repairCount, 1);
  assert.deepEqual(result.questions.slice(2, 4).map((item) => item.question), repaired);
  assert.equal(request.mock.callCount(), 2);
});

test('Project Deep Dive accepts natural project follow-ups without unnecessary repair', async (t) => {
  const fixture = require('./fixtures/syntheticInterviewResume');
  const liveContext = require('../src/services/contextBuilder').build(fixture.parsedResume, fixture.analysis, {
    targetRole: fixture.targetRole, interviewType: fixture.interviewType,
  });
  const output = [
    "Can you explain how Synthetic Ticket Routing API works from a user's point of view?",
    'Tell me about your role in building Synthetic Ticket Routing API.',
    'What happens in Synthetic Ticket Routing API when a user submits a new ticket?',
    'How did you choose to validate requests in Synthetic Ticket Routing API?',
    'Can you describe how you tested Synthetic Ticket Routing API for errors?',
    'What improvements would you make to Synthetic Inventory Service if you worked on it again?',
  ];
  const request = t.mock.method(axios, 'post', async (_url, body) => {
    return { status: 200, data: { response: JSON.stringify({
      questions: output,
    }) } };
  });
  const result = await generateCategoryQuestions(liveContext, 'project_deep_dive', { force: true });
  assert.equal(result.status, 'ready');
  assert.equal(result.metrics.repairCount, 0);
  assert.deepEqual(result.questions.map((item) => item.question), output.map((question) => question.replace(/[.!]+$/, '?')));
  assert.equal(request.mock.callCount(), 1);
});

test('Professional Experience accepts a natural technical-contribution question without slot-word matching', async (t) => {
  const fixture = require('./fixtures/syntheticInterviewResume');
  const liveContext = require('../src/services/contextBuilder').build(fixture.parsedResume, fixture.analysis, {
    targetRole: fixture.targetRole, interviewType: fixture.interviewType,
  });
  const output = [
    'Tell me about a task you handled as a Backend Engineering Intern.',
    'Can you explain how you investigated MongoDB query issues?',
    'Describe a real problem you faced while coordinating API changes.',
    'How did you implement REST endpoints and request validation?',
    'Tell me about a time when you had to verify changes with repeatable checks.',
    'What did you learn from working on a small synthetic project team?',
  ];
  const request = t.mock.method(axios, 'post', async (_url, body) => ({ status: 200, data: { response: JSON.stringify({
    questions: output,
  }) } }));
  const result = await generateCategoryQuestions(liveContext, 'professional_experience', { force: true });
  assert.equal(result.status, 'ready');
  assert.equal(result.metrics.repairCount, 0);
  assert.equal(result.questions[3].question, output[3]);
  assert.equal(request.mock.callCount(), 1);
});

test('all deterministic category fallbacks return six distinct grounded questions with honest metadata', () => {
  for (const categoryId of categoryIds.filter((id) => id !== 'technical_concepts')) {
    let result;
    try { result = heuristicFallbackCategoryQuestions(context, categoryId, plan); }
    catch (error) { error.message = `${categoryId} ${error.code} ${error.questionIndex}`; throw error; }
    assert.equal(result.source, 'heuristic-fallback');
    assert.equal(result.questions.length, QUESTION_COUNT_PER_CATEGORY);
    assert.equal(new Set(result.questions.map((item) => item.question)).size, QUESTION_COUNT_PER_CATEGORY);
    assert.ok(result.questions.every((item) => item.categoryId === categoryId && item.slotId && item.evidenceProvenance));
  }
  assert.throws(() => heuristicFallbackCategoryQuestions(context, 'technical_concepts', plan),
    { code: 'TECHNICAL_TEMPLATE_FALLBACK_DISABLED' });
  const appliedFallback = heuristicFallbackCategoryQuestions(context, 'applied_scenarios', plan).questions;
  assert.match(appliedFallback[0].question, /Suppose an API (?:using Express )?becomes slow/i);
});

test('legacy mixed generation and validation keep their original six-item contract', () => {
  const types = ['technical', 'technical', 'project', 'project', 'experience', 'behavioral'];
  const questions = types.map((type, index) => ({ question: `How would you approach design case ${index}?`, type,
    basedOn: type === 'behavioral' ? 'general' : type === 'project' ? 'Nexus Messaging Platform' : type === 'experience' ? 'Developer Intern' : 'Node.js' }));
  assert.equal(validateGeneratedQuestions({ questions }, context, plan).length, 6);
  const allTechnical = { questions: questions.map((item) => ({ ...item, type: 'technical', basedOn: item.basedOn === 'general' ? 'Node.js' : item.basedOn })) };
  assert.throws(() => validateGeneratedQuestions(allTechnical, context, plan), (error) => error.code === 'invalid-distribution');
});
