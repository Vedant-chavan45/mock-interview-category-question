/** On-demand deterministic role priorities; no network or persistence. */
const text = (v) => typeof v === 'string' ? v.trim() : '';
const list = (v) => Array.isArray(v) ? v : [];
const obj = (v) => v && typeof v === 'object' && !Array.isArray(v) ? v : {};

// Topic patterns use word boundaries to avoid matches such as SQL in NoSQL.
const topics = {
  api: ['REST API Design', /\b(rest(?:ful)?|apis?|express|node(?:\.js)?)\b/i],
  architecture: ['Software Architecture & Integration', /\b(architecture|integration|backend|server|microservices?|node(?:\.js)?|express)\b/i],
  database: ['Databases & Data Modelling', /\b(sql|mysql|postgres(?:ql)?|mongodb|databases?|schema|data modell?ing)\b/i],
  security: ['Authentication & Security', /\b(jwt|auth(?:entication|orization)?|oauth|security|encryption)\b/i],
  reliability: ['Performance & Reliability', /\b(performance|reliability|scalability|caching|latency|optim(?:iz|is)ation)\b/i],
  debugging: ['Debugging & Root-Cause Analysis', /\b(debugging|debug|bugs?|issues?|root.cause|troubleshoot\w*)\b/i],
  fundamentals: ['Programming Fundamentals & OOP', /\b(programming|oop|object.oriented|computer science|java|python|javascript|c\+\+)(?=\W|$)/i],
  javascript: ['JavaScript', /\b(javascript|typescript|js)\b/i],
  react: ['React & Component Design', /\b(react(?:\.js)?|components?|jsx)\b/i],
  state: ['State & Frontend Architecture', /\b(redux|state|frontend|front.end|react)\b/i],
  accessibility: ['Accessibility & UI', /\b(accessibility|a11y|aria|html|css|ui)\b/i],
  cpp: ['C++', /\bc\+\+(?=\W|$)|\bcpp\b/i],
  dsa: ['DSA & Problem Solving', /\b(dsa|data structures?|algorithms?|problem solving)\b/i],
  memory: ['Memory Management & Pointers', /^free$|\b(memory(?:\s+(?:management|allocation))?|dynamic\s+allocation|heap\s+allocation|malloc|free(?=\s*\()|new\s*\/\s*delete|pointers?|references?|raii)\b/i],
  stl: ['STL', /\b(stl|standard template library|vectors?|iterators?)\b/i],
  os: ['Operating Systems', /\b(os|operating systems?|linux|processes|threads?)\b/i],
  concurrency: ['Concurrency', /\b(concurrency|concurrent|threads?|mutex|synchroni[sz]ation|parallel)\b/i],
  strategy: ['Test Strategy & Edge Cases', /\b(test(?:ing|s)?|qa|quality assurance|edge cases?|coverage)\b/i],
  automation: ['Test Automation', /\b(automation|selenium|playwright|cypress|jest|pytest|junit)\b/i],
  apiTesting: ['API Testing', /\b(apis?|rest(?:ful)?|postman|supertest)\b/i],
  performanceTesting: ['Performance Testing', /\b(load test\w*|performance|stress test\w*|jmeter|k6)\b/i],
  sql: ['SQL & Joins', /\b(sql|mysql|postgres(?:ql)?|joins?|queries|querying)\b/i],
  indexes: ['Indexes & Query Optimisation', /\b(index(?:es|ing)?|queries|query|optimi[sz]\w*)\b/i],
  quality: ['Data Quality', /\b(data quality|validation|cleaning|etl|pipelines?)\b/i],
  python: ['Python', /\b(python|pandas|numpy)\b/i],
  ml: ['ML Fundamentals', /\b(machine learning|ml|scikit.learn|tensorflow|pytorch|regression|classification)\b/i],
  preprocessing: ['Data Preprocessing', /\b(preprocessing|feature engineering|cleaning|pandas|datasets?)\b/i],
  evaluation: ['Model Evaluation & Experimentation', /\b(evaluation|experiments?|accuracy|precision|recall|cross.validation)\b/i],
  deployment: ['Deployment & Integration', /\b(deploy\w*|integration|docker|serving|mlops)\b/i],
  project: ['Project Engineering & Software Design', /\b(project|design|built|implemented|developed)\b/i],
};

// First match wins: specific families precede broad software roles.
const profiles = [
  ['fullstack', 'Full Stack Engineering', /\bfull\s*stack\b/, ['architecture', 'api', 'database', 'security', 'react', 'javascript', 'debugging']],
  ['qa', 'QA / Test Engineering', /\b(qa|quality assurance|test engineer|testing|test development|automation engineer|sdet)\b/, ['strategy', 'automation', 'debugging', 'apiTesting', 'reliability', 'performanceTesting', 'fundamentals']],
  ['systems', 'C++ / Systems Engineering', /\bc\+\+(?=\W|$)|\b(cpp|systems?|embedded)\b/, ['cpp', 'fundamentals', 'dsa', 'memory', 'stl', 'os', 'concurrency', 'debugging', 'reliability']],
  ['ai-ml', 'AI / ML Engineering', /\b(machine learning|ml engineer|ai engineer|data scientist)\b/, ['python', 'ml', 'preprocessing', 'evaluation', 'deployment']],
  ['data', 'Data / SQL Engineering', /\b(data analyst|data engineer|sql developer|database developer|database engineer)\b/, ['sql', 'database', 'indexes', 'quality', 'architecture']],
  ['frontend', 'Frontend Engineering', /\b(front\s*end|react|ui)\b/, ['javascript', 'react', 'state', 'api', 'reliability', 'accessibility', 'security']],
  ['backend', 'Backend Engineering', /\b(back\s*end|node(?:\.js)?|server\s*side)\b/, ['api', 'architecture', 'database', 'security', 'reliability', 'debugging', 'fundamentals']],
  ['generic', 'Generic Software Engineering', /./, ['fundamentals', 'dsa', 'project', 'api', 'database', 'debugging', 'architecture']],
];

function buildInterviewPlan(resumeContext) {
  const c = obj(resumeContext);

  const role = text(c.targetRole)
    .toLowerCase()
    .replace(/[-_/]+/g, ' ')
    .replace(/\s+/g, ' ');

  // Employer-required skills selected during interview setup.
  const requiredSkillset = [
    ...new Set(
      list(c.requiredSkillset)
        .map(text)
        .filter(Boolean)
        .map((skill) => skill.trim())
    ),
  ];

  // Collect evidence actually present in the candidate's resume.
  const evidence = [];
  const add = (value, label = '') => {
    const claim = text(value);
    if (claim) evidence.push({ claim, label: text(label) });
  };

  list(c.skills).forEach((s) => add(s));
  list(c.projects).forEach((value) => {
    const p = obj(value);
    add(p.title);
    list(p.technologies).forEach((s) => add(s, p.title));
    add(p.description, p.title);
  });
  list(c.experience).forEach((value) => {
    const e = obj(value);
    add(e.role);
    add(e.organisation);
    list(e.responsibilities).forEach((s) => add(s, e.role));
  });
  list(c.education).forEach((value) => {
    const e = obj(value);
    add(e.degree);
    add(e.institution);
  });

  // An explicitly selected target-role profile takes priority.
  const profile = profiles.find((p) => p[2].test(role)) || profiles[profiles.length - 1];

  const interviewType = text(c.interviewType) || 'Technical';
  const behavioral = /\b(behavioral|behavioural|hr)\b/i.test(interviewType);

  // Match employer-required skills against the selected role's topic patterns.
  const focusAreas = profile[3].map((key, order) => {
    const [topic, pattern] = topics[key];
    const resumeMatches = evidence.filter((e) => pattern.test(e.claim));
    const requiredMatches = requiredSkillset.filter((skill) => pattern.test(skill));

    return {
      topic,
      priority: behavioral
        ? 'medium'
        : requiredMatches.length > 0 || resumeMatches.length > 0 || order < 3
          ? 'high'
          : 'medium',
      evidence: [
        ...new Set(resumeMatches.flatMap((e) => [e.claim, e.label]).filter(Boolean)),
      ],
      requiredSkills: requiredMatches,
      requiredSkillPriority: requiredMatches.length > 0,
    };
  });

  // Preserve required skills that do not match one of the selected profile's
  // predefined topics as explicit focus areas rather than silently dropping them.
  const coveredSkills = new Set(
    focusAreas.flatMap((area) => area.requiredSkills.map((skill) => skill.toLowerCase()))
  );

  const additionalRequiredAreas = requiredSkillset
    .filter((skill) => !coveredSkills.has(skill.toLowerCase()))
    .map((skill) => ({
      topic: skill,
      priority: 'high',
      evidence: [],
      requiredSkills: [skill],
      requiredSkillPriority: true,
      customRequiredSkill: true,
    }));

  // Required-skill topics appear first, followed by topics supported by resume evidence.
  focusAreas.sort((a, b) =>
    Number(b.requiredSkillPriority) - Number(a.requiredSkillPriority) ||
    Number(b.evidence.length > 0) - Number(a.evidence.length > 0)
  );

  focusAreas.unshift(...additionalRequiredAreas);

  if (behavioral) {
    focusAreas.unshift({
      topic: 'Communication, Collaboration & Ownership',
      priority: 'high',
      evidence: [],
      requiredSkills: [],
      requiredSkillPriority: false,
    });
  }

  return {
    primaryDomain: profile[1],
    roleProfile: profile[0],
    interviewType,
    requiredSkillset,
    emphasis: behavioral
      ? 'communication, collaboration, ownership and experience'
      : /mixed/i.test(interviewType)
        ? 'required skills first, followed by technical, project and experience breadth'
        : 'employer-required skills and technical domain depth',
    focusAreas,
  };
}

// Small stable ordering: role-specific fundamentals, exact topic keywords,
// concise anchors, then prose. No inferred evidence is added.
function rankFocusEvidence(topic, evidence, roleProfile) {
  const definition = Object.values(topics).find(([name]) => name === topic);
  const exact = definition ? new RegExp(`^(?:${definition[1].source})$`, 'i') : null;
  const rank = (value) => {
    const claim = text(value);
    if (roleProfile === 'systems' && topic === topics.fundamentals[0]) {
      if (/^(oop|object[ -]oriented(?: programming)?)$/i.test(claim)) return 0;
      if (/^(c\+\+|cpp)$/i.test(claim)) return 1;
      return claim.split(/\s+/).length <= 5 ? 3 : 4;
    }
    if (claim.toLowerCase() === topic.toLowerCase()) return 0;
    if (exact && exact.test(claim)) return 1;
    if (definition && definition[1].test(claim)) return claim.split(/\s+/).length <= 5 ? 2 : 3;
    return 4; // Context labels do not outrank the claim that actually matched the topic.
  };
  return stringsOnly(evidence).sort((a, b) => rank(a) - rank(b));
}

function stringsOnly(values) { return list(values).map(text).filter(Boolean); }

module.exports = { buildInterviewPlan, rankFocusEvidence };
