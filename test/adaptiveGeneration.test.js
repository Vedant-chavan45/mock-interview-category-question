'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');
const contextBuilder = require('../src/services/contextBuilder');
const generator = require('../src/services/questionGeneratorService');
const { validateTechnicalQuestion } = require('../src/services/questionQualityService');
const { rotationForCategory, detectCoveredSkills, buildCoverageLedger } = require('../src/services/questionRotationService');

const aiMlSkills = ['Python', 'Data Preprocessing', 'Machine Learning Fundamentals', 'Pandas', 'NumPy', 'PyTorch', 'Model Evaluation'];

const profiles = {
  Python: ['generator iteration and yield', 'mutability and object identity', 'exception propagation and context managers', 'GIL and asynchronous I/O'],
  'Data Preprocessing': ['train test separation and leakage', 'fit transform and scaling', 'categorical encoding and unseen values', 'outlier treatment and missing data'],
  'Machine Learning Fundamentals': ['bias variance and generalization', 'regularization and overfitting', 'validation splits and leakage', 'classification metrics and imbalance'],
  Pandas: ['index alignment and loc iloc', 'groupby aggregation and missing values', 'merge keys and duplicate rows', 'vectorization and memory use'],
  NumPy: ['array shape and broadcasting', 'views copies and mutation', 'dtype promotion and overflow', 'vectorized operations and strides'],
  PyTorch: ['autograd graph and backward', 'tensor shapes and broadcasting', 'train eval modes and dropout', 'optimizer steps and gradient clearing'],
  'Model Evaluation': ['precision recall and F1', 'confusion matrix and class imbalance', 'cross validation and leakage', 'threshold selection and calibration'],
  'Embedded C': ['volatile memory mapped registers', 'pointer arithmetic and buffer bounds', 'interrupt service routines and latency', 'integer width and overflow'],
  FreeRTOS: ['task scheduling and preemption', 'mutex priority inversion', 'queue ownership and task notification', 'stack sizing and overflow'],
  'CAN bus': ['identifier arbitration and bus load', 'frame payload and bit timing', 'error counters and bus off recovery', 'message priority and latency'],
  'CAN bus protocol': ['identifier arbitration and bus load', 'frame payload and bit timing', 'error counters and bus off recovery', 'message priority and latency'],
};

const kinds = {
  Python: 'programming_language',
  'Embedded C': 'programming_language',
  'Data Preprocessing': 'workflow_process',
  'Machine Learning Fundamentals': 'umbrella_topic',
  Pandas: 'framework_library',
  NumPy: 'framework_library',
  PyTorch: 'framework_library',
  'Model Evaluation': 'modeling_evaluation',
  FreeRTOS: 'framework_library',
  'CAN bus': 'core_concept',
  'CAN bus protocol': 'core_concept',
};

function contextFor(requiredSkillset, skills = []) {
  const parsed = { skills, projects: [], experience: [], education: [], certifications: [] };
  const analysis = { summary: '', strengths: [], skillAreasToProbe: [], source: 'test' };
  return contextBuilder.build(parsed, analysis, { targetRole: 'AI/ML Intern', interviewType: 'Technical', requiredSkillset });
}

function ontologyFor(skills) {
  return { skillPlans: skills.map((name) => ({
    kind: kinds[name] || 'other', confidence: kinds[name] ? 0.94 : 0.62,
    interpretation: `${name} is assessed through its domain-specific mechanisms and decisions.`,
    subtopics: (profiles[name] || [`${name} core mechanism`, `${name} inputs and state`, `${name} failure behavior`, `${name} performance limits`])
      .map((subtopic, subtopicIndex) => {
        const keyTerms = subtopic.split(/\s+(?:and|or)\s+|\s+/).filter((word) => word.length > 3).slice(0, 5);
        const angles = [0, 1, 2].map((angleIndex) => ({
          objective: `Reason about ${subtopic} ${['when an input changes', 'at a boundary condition', 'during a failure'][angleIndex]}`,
          style: ['mechanism', 'code reasoning', 'debugging', 'data scenario', 'edge case', 'evaluation'][((subtopicIndex + angleIndex) % 6)],
          assessmentCriteria: [`Explain ${subtopic.split(' ')[0]} behavior`, 'Connect the mechanism to an observable result'],
        }));
        return { name: subtopic, keyTerms, angles };
      }),
  })) };
}

function parseJsonAfter(prompt, marker, until = '\n') {
  const markerIndex = prompt.indexOf(marker);
  assert.notEqual(markerIndex, -1, `missing prompt marker ${marker}`);
  const start = markerIndex + marker.length;
  const end = until ? prompt.indexOf(until, start) : -1;
  return JSON.parse(prompt.slice(start, end < 0 ? undefined : end).trim());
}

function questionFor(target, index) {
  // Deterministic semantic fixtures for the mock model; production generation
  // has no question bank and asks Ollama to write from the dynamic blueprint.
  const topic = target.subtopic.toLowerCase();
  const angle = target.objective?.toLowerCase() || '';
  if (topic.includes('generator')) return !angle.includes('when an input changes')
    ? 'A Python generator has yielded its final item; what does the next call to next() raise, and why?'
    : 'What state does a Python generator preserve when it pauses at yield, and how does iteration resume on the next call?';
  if (topic.includes('mutability')) return !angle.includes('when an input changes')
    ? 'How does Python object identity expose mutability when two names point to the same list, and how would you copy it?'
    : 'How does Python mutability affect object identity when two names reference the same list?';
  if (topic.includes('exception')) return !angle.includes('when an input changes')
    ? 'If a Python with block raises, what can __exit__ return to suppress or propagate that exception?'
    : 'When an exception escapes a Python context manager, how does its exit method affect propagation?';
  if (topic.includes('gil') || topic.includes('asynchronous')) return !angle.includes('when an input changes')
    ? 'Which network-bound Python tasks can asyncio overlap despite the GIL, and what CPU-bound work still blocks?'
    : 'When does asynchronous I/O improve network-bound Python concurrency despite the GIL, and what work does it not speed up?';
  if (topic.includes('train test separation') || topic.includes('leakage')) return 'How does train and test separation prevent data leakage when a scaler is fit on training data only?';
  if (topic.includes('fit transform') || topic.includes('scaling')) return 'Why must fit and transform stay separate during scaling to prevent leakage from validation data?';
  if (topic.includes('categorical encoding')) return 'How should categorical encoding handle an unseen category that appears only in validation data?';
  if (topic.includes('outlier')) return 'How would you treat an outlier and missing data without fitting preprocessing statistics on validation rows?';
  if (topic.includes('bias variance')) return 'How do training and validation scores reveal a bias/variance tradeoff, and what regularization change could improve generalization?';
  if (topic.includes('regularization')) return 'How can regularization reduce overfitting, and what usually happens to training error as its strength increases?';
  if (topic.includes('validation splits')) return 'How can repeated test-set checks leak information into model selection, and what role should validation data play?';
  if (topic.includes('classification metrics')) return 'For imbalanced classification, why can accuracy mislead you, and when would recall matter more than precision?';
  if (topic.includes('index alignment')) return !angle.includes('when an input changes')
    ? 'When one Series lacks an index label, what value appears after Pandas aligns the addition, and how could fillna affect it?'
    : 'How does Pandas index alignment work when adding Series with different labels, and what happens to labels found in only one?';
  if (topic.includes('groupby')) return !angle.includes('when an input changes')
    ? 'What does dropna=False change for missing keys in a Pandas groupby, and how might that affect aggregate totals?'
    : 'How does a Pandas groupby aggregation treat missing values in group keys, and when would you retain those groups?';
  if (topic.includes('merge keys')) return !angle.includes('when an input changes')
    ? 'In a one-to-many Pandas merge, how can validate detect unexpected duplicate-key cardinality?'
    : 'How can duplicate keys in a Pandas merge multiply output rows, and how would you detect that?';
  if (topic.includes('vectorization')) return !angle.includes('when an input changes')
    ? 'How would you replace row-wise apply with vectorized Pandas operations, and what runtime and memory costs would you compare?'
    : 'Why can Pandas vectorization use less time and memory than iterating over rows?';
  if (topic.includes('broadcasting')) return 'What result shape does NumPy broadcasting produce for arrays shaped (m, 1) and (1, n), and why?';
  if (topic.includes('views copies')) return 'How do NumPy views and copies differ in shared memory, and how can mutation through a view affect its source?';
  if (topic.includes('dtype')) return 'How can NumPy dtype promotion change an arithmetic result, and when can integer overflow occur?';
  if (topic.includes('autograd')) return 'In PyTorch autograd, where does backward() place gradients in the computation graph, and why clear them before the next batch?';
  if (topic.includes('tensor shapes')) return 'How do PyTorch tensor shapes affect broadcasting in a forward pass, and which dimensions should match?';
  if (topic.includes('train eval modes')) return 'What changes between PyTorch train() and eval() modes for dropout, and when should each be used?';
  if (topic.includes('optimizer steps')) return 'Why is gradient clearing needed before backward(), and when should the PyTorch optimizer step run?';
  if (topic.includes('precision recall')) return 'For imbalanced classification, why can accuracy hide poor performance, and what precision, recall, and F1 tradeoff would you inspect?';
  if (topic.includes('confusion matrix')) return 'How does a confusion matrix help distinguish false positives from false negatives for an imbalanced classifier?';
  if (topic.includes('cross validation')) return 'How would you keep preprocessing inside each cross-validation fold to avoid leakage?';
  if (topic.includes('threshold selection')) return 'How does changing a classification threshold affect precision and recall, and how would you select it?';
  if (topic.includes('volatile')) return 'Why may volatile be needed for a memory-mapped C register, and what does volatile not guarantee?';
  if (topic.includes('pointer arithmetic')) return 'How can pointer arithmetic cross a C buffer boundary, and what bounds check prevents the out-of-range access?';
  if (topic.includes('interrupt')) return 'Why should an interrupt service routine stay short, and how can it safely signal work to a task?';
  if (topic.includes('integer width')) return 'How can signed integer overflow corrupt a C buffer-size calculation, and what range check would prevent it?';
  if (topic.includes('task scheduling')) return 'How does preemption affect which FreeRTOS task runs, and what can make a blocked task ready again?';
  if (topic.includes('priority inversion')) return 'How can a low-priority task holding a mutex delay a high-priority task, and how does inheritance help?';
  if (topic.includes('queue ownership')) return 'When a FreeRTOS task sends a pointer through a queue, who owns the referenced buffer afterward?';
  if (topic.includes('stack sizing')) return 'How would you detect a FreeRTOS task stack overflow before it corrupts adjacent state?';
  if (topic.includes('identifier arbitration')) return 'How does CAN identifier arbitration let the higher-priority frame win without corrupting the message?';
  if (topic.includes('frame payload')) return 'How do payload size and bit timing affect the transmission time of a CAN frame?';
  if (topic.includes('error counters')) return 'What can cause a CAN controller to enter bus-off, and how should recovery be handled?';
  if (topic.includes('message priority')) return 'How would CAN message identifiers affect latency for a time-critical signal?';
  const terms = target.keyTerms?.slice(0, 2).join(' and ') || target.subtopic;
  return `For ${target.subtopic}, which condition changes ${terms}, and what would you expect to observe?`;
}

function mockOllama(t, { reviewRejectFirst = false } = {}) {
  let reviewerCalls = 0;
  const calls = [];
  t.mock.method(axios, 'post', async (_url, body) => {
    calls.push(body.prompt);
    let payload;
    if (body.prompt.startsWith('You are the technical assessment planner')) {
      const marker = 'TARGETS IN REQUIRED ORDER: ';
      const skills = parseJsonAfter(body.prompt, marker, '\nPRIOR COVERAGE');
      payload = ontologyFor(skills);
    } else if (body.prompt.startsWith('Role ') && body.prompt.includes('QUESTION OBJECTIVES IN ORDER')) {
      const targets = parseJsonAfter(body.prompt, 'QUESTION OBJECTIVES IN ORDER (dynamic assessment blueprint): ', '\nPREVIOUS QUESTIONS');
      payload = { questions: targets.map((target, index) => questionFor(target, index)) };
    } else if (body.prompt.startsWith('Independently review these six')) {
      const targets = parseJsonAfter(body.prompt, 'ASSESSMENT PLAN AND QUESTIONS: ', '\nPREVIOUSLY ASSESSED');
      reviewerCalls += 1;
      payload = { reviews: targets.map((target, index) => ({
        slotId: target.slotId,
        targetAlignment: reviewRejectFirst && reviewerCalls === 1 && index === 2 ? 2 : 5,
        technicalCoherence: 5, roleLevelFit: 5, spokenClarity: 5, objectiveUniqueness: 5, issueCodes: [],
      })) };
    } else if (body.prompt.startsWith('Replace only the listed weak questions')) {
      const repairs = parseJsonAfter(body.prompt, 'REPAIR TARGETS: ', '\nCURRENT SET');
      payload = { questions: repairs.map((target, index) => questionFor({
        subtopic: target.subtopic, keyTerms: target.keyTerms, objective: `${target.objective} at a boundary condition`,
      }, index + 3)) };
    } else {
      throw new Error(`Unexpected model stage: ${body.prompt.slice(0, 80)}`);
    }
    return { status: 200, data: { response: JSON.stringify(payload) } };
  });
  return { calls, reviewerCalls: () => reviewerCalls };
}

test('all six reported bad templates and paraphrases fail for topical, generic, or category reasons', () => {
  const slots = [
    { primaryAssessmentTarget: 'Python', primaryRequiredSkill: 'Python', skillKind: 'programming_language', subtopic: 'generator iteration and yield', keyTerms: ['generator', 'iteration', 'yield', 'iterator'] },
    { primaryAssessmentTarget: 'Data Preprocessing', primaryRequiredSkill: 'Data Preprocessing', skillKind: 'workflow_process', subtopic: 'train test separation and leakage', keyTerms: ['train test', 'separation', 'leakage', 'validation'] },
    { primaryAssessmentTarget: 'Machine Learning Fundamentals', primaryRequiredSkill: 'Machine Learning Fundamentals', skillKind: 'umbrella_topic', subtopic: 'bias variance and generalization', keyTerms: ['bias', 'variance', 'generalization', 'overfitting'] },
    { primaryAssessmentTarget: 'Pandas', primaryRequiredSkill: 'Pandas', skillKind: 'framework_library', subtopic: 'vectorization and memory use', keyTerms: ['vectorization', 'memory', 'array', 'operation'] },
    { primaryAssessmentTarget: 'NumPy', primaryRequiredSkill: 'NumPy', skillKind: 'framework_library', subtopic: 'views copies and mutation', keyTerms: ['views', 'copies', 'mutation', 'array'] },
    { primaryAssessmentTarget: 'PyTorch', primaryRequiredSkill: 'PyTorch', skillKind: 'framework_library', subtopic: 'autograd graph and backward', keyTerms: ['autograd', 'gradient', 'backward', 'graph'] },
  ];
  const blueprint = { slots, skillClassifications: [
    { name: 'PyTorch', kind: 'framework_library' }, { name: 'Model Evaluation', kind: 'modeling_evaluation' },
  ] };
  const context = { skills: [], requiredSkillset: aiMlSkills };
  const fixtures = [
    ['How would you use Python to build a small feature and check that it works?', 'off-target-subtopic'],
    ['What is a practical way to use Python in an application and confirm it behaves correctly?', 'off-target-subtopic'],
    ['How do you connect Data Preprocessing to the rest of an app?', 'generic-template-framing'],
    ['Where does data preprocessing fit within the rest of an application?', 'off-target-subtopic'],
    ['A feature using Machine Learning Fundamentals stops working. How would you find the cause?', 'generic-template-framing'],
    ['If something built with machine learning basics breaks, how would you debug the feature?', 'off-target-subtopic'],
    ['A feature using Pandas becomes slow under load. What would you check first?', 'generic-template-framing'],
    ['A pandas backed component slows during peak traffic; what would you inspect?', 'off-target-subtopic'],
    ['How would you check that data handled by NumPy is safe?', 'generic-template-framing'],
    ['How do you ensure information stays protected while using NumPy?', 'off-target-subtopic'],
    ['When would you choose PyTorch instead of Model Evaluation?', 'incomparable-skill-types'],
    ['In what situation would PyTorch be preferable to model scoring?', 'off-target-subtopic'],
  ];
  for (const [question, reason] of fixtures) {
    const slot = question.includes('PyTorch') ? slots[5] : question.toLowerCase().includes('pandas') ? slots[3] :
      question.includes('NumPy') ? slots[4] : question.toLowerCase().includes('preprocessing') ? slots[1] :
        question.toLowerCase().includes('machine learning') ? slots[2] : slots[0];
    assert.equal(validateTechnicalQuestion(question, slot, blueprint, context), reason, question);
  }
  assert.equal(validateTechnicalQuestion('How did you use Python generators to resume iteration after yield?',
    { ...slots[0], primaryRequiredSkill: 'Python' }, blueprint, context), 'unsupported-required-skill-experience');
});

test('seven-skill AI/ML generation and JSON-reloaded history prioritize the uncovered skill with new objectives', async (t) => {
  const context = contextFor(aiMlSkills);
  mockOllama(t);
  const first = await generator.generateCategoryQuestions(context, 'technical_concepts', { force: true });
  assert.equal(first.status, 'ready');
  assert.equal(first.questions.length, 6);
  assert.deepEqual(first.questions.map((question) => question.primaryRequiredSkill), aiMlSkills.slice(0, 6));
  assert.ok(first.questions.every((question) => question.evidenceIds.length === 0));
  assert.ok(first.questions.every((question) => question.evidenceProvenance.kind === 'required_skill_assessment'));
  assert.equal(new Set(first.questions.map((question) => question.coverageSignature)).size, 6);
  assert.ok(first.questions.every((question) => question.assessmentCriteria.length >= 2));

  // Simulate MongoDB JSON persistence and a browser reload before regenerating.
  const persisted = JSON.parse(JSON.stringify({
    generationNumber: 1,
    questions: first.questions.map((question) => ({ ...question, answer: '', evaluation: null })),
    skillsCovered: detectCoveredSkills(first.questions, aiMlSkills),
    coverage: first.questions.map(({ primaryRequiredSkill, primaryAssessmentTarget, subtopic, assessmentObjective, coverageSignature }) =>
      ({ primaryRequiredSkill, primaryAssessmentTarget, subtopic, assessmentObjective, coverageSignature })),
  }));
  const history = [{ ...persisted }];
  const secondRotation = rotationForCategory(context, 'technical_concepts', history);
  assert.equal(secondRotation.uncoveredSkills[0], 'Model Evaluation');
  const second = await generator.generateCategoryQuestions(context, 'technical_concepts', { force: true, history });
  assert.equal(second.questions.length, 6);
  assert.ok(second.questions.some((question) => question.primaryRequiredSkill === 'Model Evaluation'));
  assert.equal(new Set(second.questions.map((question) => question.coverageSignature)).size, 6);
  assert.ok(second.questions.every((question) => !persisted.questions.some((previous) =>
    previous.coverageSignature === question.coverageSignature)));
  assert.deepEqual(detectCoveredSkills(second.questions, aiMlSkills).length, 6);

  const ledger = buildCoverageLedger(history, aiMlSkills, second.questions, 2);
  assert.equal(ledger.find((entry) => entry.skill === 'Model Evaluation').assessmentCount, 1);
  assert.equal(ledger.find((entry) => entry.skill === 'Model Evaluation').lastAssessedGeneration, 2);
  assert.ok(ledger.every((entry) => entry.assessmentCount >= 1));

  const representative = [...first.questions, ...second.questions].map((question) => ({
    question: question.question,
    primaryRequiredSkill: question.primaryRequiredSkill,
    subtopic: question.subtopic,
    assessmentObjective: question.assessmentObjective,
  }));
  assert.equal(representative.length, 12);
  assert.ok(representative.some((question) => question.primaryRequiredSkill === 'Model Evaluation'));
  assert.equal(new Set(representative.map((question) => question.question)).size, 12);
  assert.ok(representative.every((question) => !/how would you use .* feature|in an app|under load|keep .* safe/i.test(question.question)));
  if (process.env.PRINT_TECHNICAL_DEMO === '1') {
    console.log(`CONTROLLED_MOCK_TECHNICAL_OUTPUT=${JSON.stringify(representative)}`);
  }
});

test('two skills rotate subtopics and objectives across two generations without static question skeletons', async (t) => {
  const skills = ['Python', 'Pandas'];
  const context = contextFor(skills);
  mockOllama(t);
  const first = await generator.generateCategoryQuestions(context, 'technical_concepts', { force: true });
  const second = await generator.generateCategoryQuestions(context, 'technical_concepts', {
    force: true, history: [{ questions: JSON.parse(JSON.stringify(first.questions)), skillsCovered: skills }],
  });
  for (const skill of skills) {
    const a = first.questions.filter((question) => question.primaryRequiredSkill === skill);
    const b = second.questions.filter((question) => question.primaryRequiredSkill === skill);
    assert.equal(a.length, 3);
    assert.equal(b.length, 3);
    assert.ok(new Set(a.map((question) => question.subtopic)).size >= 3);
    assert.ok(new Set(b.map((question) => question.assessmentObjective)).size >= 3);
  }
  assert.ok(first.questions.every((question) => !second.questions.some((next) =>
    next.coverageSignature === question.coverageSignature)));
  assert.ok(new Set([...first.questions, ...second.questions].map((question) => question.question)).size >= 10);
});

test('project deep dive stays resume-grounded, mixes technical questions with ownership, and rotates its angles', async (t) => {
  const fixture = require('./fixtures/syntheticInterviewResume');
  const context = contextBuilder.build(fixture.parsedResume, fixture.analysis, {
    targetRole: fixture.targetRole, interviewType: fixture.interviewType,
  });
  const firstSet = [
    'Can you explain how request validation and MongoDB storage fit together in the Synthetic Ticket Routing API?',
    'Which part of the Synthetic Ticket Routing API did you personally implement, and how did it fit into the request flow?',
    'Walk me through how a ticket moves from a REST request through validation to its saved state in MongoDB.',
    'Why did the Synthetic Ticket Routing API use Express for its REST endpoints, and what trade-off would you consider before changing that choice?',
    'How would you test a ticket request that fails validation and confirm the API returns a consistent error?',
    "If a ticket's stored state changed unexpectedly, how would you trace the request and verify where the change occurred?",
  ];
  const secondSet = [
    'How would you divide responsibility between the ticket endpoint and request validation as the API grows?',
    'What part of the Synthetic Inventory Service did you own, and what check would show that your change worked?',
    'How would you verify that an inventory update is reflected in MongoDB after a valid request?',
    'If a request is accepted but the inventory response contains an error, where would you inspect the API flow first?',
    'What boundary cases would you add for permission checks on inventory updates, and how would you assert each response?',
    'Which design limitation in either documented service would you address first, and how would you test the improvement?',
  ];
  let generation = 0;
  const request = t.mock.method(axios, 'post', async (_url, body) => {
    assert.match(body.prompt, /Synthetic Ticket Routing API/);
    assert.match(body.prompt, /MongoDB/);
    const output = generation++ === 0 ? firstSet : secondSet;
    return { status: 200, data: { response: JSON.stringify({ questions: output }) } };
  });

  const first = await generator.generateCategoryQuestions(context, 'project_deep_dive', { force: true });
  assert.equal(first.questions.length, 6);
  assert.equal(first.questions.filter((item) => item.slotId === 'individual_contribution').length, 1);
  assert.ok(first.questions.every((item) => item.evidenceProvenance.kind === 'resume_project'));
  assert.ok(first.questions.some((item) => /validation|MongoDB/.test(item.question)));
  assert.ok(first.questions.some((item) => /REST request|request flow/.test(item.question)));
  assert.ok(first.questions.some((item) => /Express|trade-off/.test(item.question)));
  assert.ok(first.questions.some((item) => /test|error/.test(item.question)));
  assert.doesNotMatch(first.questions.map((item) => item.question).join(' '), /Redis|AWS|PostgreSQL|Kafka/);

  const persisted = JSON.parse(JSON.stringify({ questions: first.questions, generationNumber: 1 }));
  const second = await generator.generateCategoryQuestions(context, 'project_deep_dive', {
    force: true, history: [persisted],
  });
  assert.equal(second.questions.length, 6);
  assert.ok(second.questions.every((item) => !first.questions.some((old) => old.question === item.question)));
  assert.ok(second.questions.some((item) => /permission|boundary cases/.test(item.question)));
  assert.equal(request.mock.callCount(), 2, 'regeneration must request a fresh set from Ollama');
});

test('unfamiliar embedded requirements are interpreted as typed assessment targets, not resume credentials', async (t) => {
  const skills = ['Embedded C', 'FreeRTOS', 'CAN bus'];
  const context = contextFor(skills, []);
  const mock = mockOllama(t);
  const result = await generator.generateCategoryQuestions(context, 'technical_concepts', { force: true });
  assert.equal(result.questions.length, 6);
  assert.ok(result.questions.every((question) => skills.includes(question.primaryRequiredSkill)));
  assert.ok(result.questions.some((question) => question.skillKind === 'core_concept'));
  assert.ok(result.questions.some((question) => question.skillKind === 'framework_library'));
  assert.ok(result.questions.every((question) => question.evidenceIds.length === 0));
  assert.ok(mock.calls[0].includes('untrusted data'));
  assert.ok(result.questions.every((question) => question.assessmentProvenance === 'required_skill'));
});

test('no selected skills uses an explicit role fallback without pretending the role was a resume skill', async (t) => {
  const context = contextFor([], []);
  mockOllama(t);
  const result = await generator.generateCategoryQuestions(context, 'technical_concepts', { force: true });
  assert.equal(result.questions.length, 6);
  assert.ok(result.questions.every((question) => question.coverageFallback === true));
  assert.ok(result.questions.every((question) => question.assessmentProvenance === 'role_fallback'));
  assert.ok(result.questions.every((question) => !question.primaryRequiredSkill && !question.primaryResumeSkill));
  assert.ok(result.questions.every((question) => question.evidenceProvenance.kind === 'role_fundamental'));
});

test('an independent quality reviewer can request a bounded targeted repair', async (t) => {
  const context = contextFor(['Python', 'Pandas']);
  const mock = mockOllama(t, { reviewRejectFirst: true });
  const result = await generator.generateCategoryQuestions(context, 'technical_concepts', { force: true });
  assert.equal(result.status, 'ready');
  assert.equal(result.metrics.repairCount, 1);
  assert.equal(result.metrics.qualityReviewCalls, 2);
  assert.equal(mock.reviewerCalls(), 2);
  assert.equal(result.questions.length, 6);
});
