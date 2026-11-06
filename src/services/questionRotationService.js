'use strict';

// Server-owned category coverage ledger. New sets use validated planner
// metadata; legacy history remains readable through its saved skillsCovered.
const { normalize } = require('./skillAssessmentPlanner');
const list = (value) => Array.isArray(value) ? value : [];

function normalizeQuestion(value) {
  if (typeof value === 'string') return { question: value };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return { ...value, question: typeof value.question === 'string' ? value.question : '' };
}

function coverageFromQuestion(question) {
  if (!question || typeof question !== 'object') return null;
  const skill = typeof question.primaryRequiredSkill === 'string' ? question.primaryRequiredSkill : '';
  const target = typeof question.primaryAssessmentTarget === 'string' ? question.primaryAssessmentTarget : skill;
  const subtopic = typeof question.subtopic === 'string' ? question.subtopic : '';
  const objective = typeof question.assessmentObjective === 'string' ? question.assessmentObjective : '';
  const signature = typeof question.coverageSignature === 'string' ? question.coverageSignature : '';
  if (!skill && !target) return null;
  return { primaryRequiredSkill: skill, primaryAssessmentTarget: target, subtopic, assessmentObjective: objective, coverageSignature: signature };
}

function normalizeHistory(history) {
  return list(history).slice(-30).map((set) => {
    const questions = list(set?.questions).map(normalizeQuestion).filter((question) => question?.question);
    const metadataCoverage = [
      ...list(set?.coverage),
      ...questions.map(coverageFromQuestion).filter(Boolean),
    ];
    const coverage = [...new Map(metadataCoverage.filter(Boolean).map((entry) => {
      const normalized = {
        primaryRequiredSkill: typeof entry.primaryRequiredSkill === 'string' ? entry.primaryRequiredSkill : '',
        primaryAssessmentTarget: typeof entry.primaryAssessmentTarget === 'string' ? entry.primaryAssessmentTarget : '',
        subtopic: typeof entry.subtopic === 'string' ? entry.subtopic : '',
        assessmentObjective: typeof entry.assessmentObjective === 'string' ? entry.assessmentObjective : '',
        coverageSignature: typeof entry.coverageSignature === 'string' ? entry.coverageSignature : '',
      };
      const key = normalized.coverageSignature || [normalized.primaryRequiredSkill, normalized.subtopic, normalized.assessmentObjective].map(normalize).join('|');
      return [key, normalized];
    }))].map(([, entry]) => entry);
    return {
      questions,
      skillsCovered: [...new Set(list(set?.skillsCovered).filter((skill) => typeof skill === 'string'))],
      coverage,
      generationNumber: Number.isInteger(set?.generationNumber) ? set.generationNumber : undefined,
    };
  });
}

function rotationForCategory(context, categoryId, history = []) {
  const sets = normalizeHistory(history);
  const requiredSkills = [...new Map(list(context?.requiredSkillset)
    .filter((skill) => typeof skill === 'string' && skill.trim())
    .map((skill) => [normalize(skill), skill.trim()])).values()];
  const skillCounts = Object.fromEntries(requiredSkills.map((skill) => [normalize(skill), 0]));
  const targetCounts = { ...skillCounts };
  const assessmentSignatures = new Set();
  const subtopicSignatures = new Set();
  const previousQuestions = [];

  for (const set of sets) {
    previousQuestions.push(...set.questions.map((item) => item.question));
    const setCovered = new Set(set.coverage.map((entry) => normalize(entry.primaryRequiredSkill)).filter(Boolean));
    // Pre-metadata history has only the server's former skillsCovered field.
    if (!set.coverage.length) list(set.skillsCovered).forEach((skill) => setCovered.add(normalize(skill)));
    for (const skill of requiredSkills) {
      if (setCovered.has(normalize(skill))) skillCounts[normalize(skill)] += 1;
    }
    for (const entry of set.coverage) {
      const targetKey = normalize(entry.primaryAssessmentTarget || entry.primaryRequiredSkill);
      if (targetKey) targetCounts[targetKey] = (targetCounts[targetKey] || 0) + 1;
      if (entry.coverageSignature) assessmentSignatures.add(normalize(entry.coverageSignature));
      else if (entry.primaryAssessmentTarget) {
        assessmentSignatures.add([entry.primaryAssessmentTarget, entry.subtopic, entry.assessmentObjective].map(normalize).join('|'));
      }
      if (entry.primaryAssessmentTarget && entry.subtopic) {
        subtopicSignatures.add([entry.primaryAssessmentTarget, entry.subtopic, ''].map(normalize).join('|'));
      }
    }
  }

  const indexed = requiredSkills.map((skill, index) => ({ skill, index, count: skillCounts[normalize(skill)] }));
  indexed.sort((a, b) => a.count - b.count || a.index - b.index);
  const selectedSkills = indexed.slice(0, 6).map((entry) => entry.skill);
  if (selectedSkills.length && selectedSkills.length < 6) {
    let slotCounts = new Map(selectedSkills.map((skill) => [normalize(skill), 1]));
    while (selectedSkills.length < 6) {
      const next = indexed.slice().sort((a, b) =>
        (a.count + (slotCounts.get(normalize(a.skill)) || 0)) - (b.count + (slotCounts.get(normalize(b.skill)) || 0)) || a.index - b.index
      )[0];
      selectedSkills.push(next.skill);
      slotCounts.set(normalize(next.skill), (slotCounts.get(normalize(next.skill)) || 0) + 1);
    }
  }

  return {
    generationIndex: sets.length,
    previousQuestions: previousQuestions.slice(-180),
    selectedSkills,
    uncoveredSkills: indexed.filter((entry) => entry.count === 0).map((entry) => entry.skill),
    skillCounts: targetCounts,
    assessmentSignatures: [...assessmentSignatures],
    subtopicSignatures: [...subtopicSignatures],
    coverageSummary: indexed.map((entry) => ({ skill: entry.skill, assessmentCount: entry.count })),
  };
}

function detectCoveredSkills(questions, requiredSkills) {
  const validated = list(questions);
  return list(requiredSkills).filter((skill) => validated.some((question) =>
    typeof question?.primaryRequiredSkill === 'string' && normalize(question.primaryRequiredSkill) === normalize(skill)
  ));
}

function buildCoverageLedger(history, requiredSkills, currentQuestions, generationNumber) {
  const sets = normalizeHistory(history);
  sets.push(...normalizeHistory([{ questions: currentQuestions, generationNumber }]));
  const bySkill = new Map(list(requiredSkills).map((skill) => [normalize(skill), {
    skill,
    assessmentCount: 0,
    lastAssessedGeneration: null,
    assessedSubtopics: [],
  }]));
  sets.slice(-30).forEach((set, setIndex) => {
    for (const entry of set.coverage) {
      const key = normalize(entry.primaryRequiredSkill);
      if (!key || !bySkill.has(key)) continue;
      const item = bySkill.get(key);
      item.assessmentCount += 1;
      item.lastAssessedGeneration = setIndex === sets.length - 1 ? generationNumber : set.generationNumber || setIndex + 1;
      if (entry.subtopic && !item.assessedSubtopics.some((value) => normalize(value) === normalize(entry.subtopic))) {
        item.assessedSubtopics.push(entry.subtopic);
      }
    }
    // Backward compatibility for legacy sets without structured coverage.
    if (!set.coverage.length) for (const skill of set.skillsCovered) {
      const item = bySkill.get(normalize(skill));
      if (item) {
        item.assessmentCount += 1;
        item.lastAssessedGeneration = set.generationNumber || setIndex + 1;
      }
    }
  });
  return [...bySkill.values()].map((item) => ({ ...item, assessedSubtopics: item.assessedSubtopics.slice(-12) }));
}

module.exports = { rotationForCategory, detectCoveredSkills, normalizeHistory, buildCoverageLedger };
