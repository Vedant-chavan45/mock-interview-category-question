'use strict';

const { getQuestionCategory, getCategorySlots } = require('./questionCategories');
const { buildInterviewPlan } = require('./interviewPlannerService');

const text = (value) => typeof value === 'string' ? value.trim() : '';
const list = (value) => Array.isArray(value) ? value : [];
const object = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const compact = (value, max = 140) => {
  const clean = text(value).replace(/\s+/g, ' ');
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max - 1);
  const boundary = cut.lastIndexOf(' ');
  return `${(boundary > max * 0.6 ? cut.slice(0, boundary) : cut).trim()}…`;
};

function contextData(resumeContext) {
  const c = object(resumeContext);
  const stored = object(c.structuredEvidence);
  const roleEvidence = object(stored.targetRole);
  const storedRequiredSkills = list(stored.requiredSkillset);

  const requiredSkillset = list(c.requiredSkillset)
    .map(text)
    .filter(Boolean)
    .filter((value, index, all) =>
      all.findIndex((item) => item.toLowerCase() === value.toLowerCase()) === index
    );

  return {
    targetRole: text(c.targetRole) || 'Not specified',
    targetRoleEvidenceId: text(roleEvidence.id) || 'role_target',
    interviewType: text(c.interviewType) || 'Technical',
    requiredSkillset,
    requiredSkillEvidence: requiredSkillset.map((name, index) => ({
      id: text(storedRequiredSkills[index]?.id) || `required_skill_${index + 1}`,
      name,
    })),
    skills: list(c.skills).map(text).filter(Boolean),
    skillEvidence: list(c.skills).map((value, index) => ({
      id: text(list(stored.skills)[index]?.id) || `skill_${index + 1}`,
      name: text(value),
    })).filter((item) => item.name),
    projects: list(c.projects).map((value, index) => {
      const p = object(value);
      return {
        id: text(list(stored.projects)[index]?.id) || `project_${index + 1}`,
        title: text(p.title),
        description: text(p.description),
        technologies: list(p.technologies).map(text).filter(Boolean),
      };
    }).filter((p) => p.title || p.description || p.technologies.length),
    experience: list(c.experience).map((value, index) => {
      const e = object(value);
      return {
        id: text(list(stored.experience)[index]?.id) || `experience_${index + 1}`,
        role: text(e.role),
        organisation: text(e.organisation),
        duration: text(e.duration),
        responsibilities: list(e.responsibilities).map(text).filter(Boolean),
      };
    }).filter((e) => e.role || e.organisation || e.duration || e.responsibilities.length),
    experienceSummary: text(c.experienceSummary),
    education: list(c.education).map((value) => {
      const e = object(value);
      return { degree: text(e.degree), institution: text(e.institution), year: text(e.year) };
    }).filter((e) => e.degree || e.institution || e.year),
  };
}

function skillEvidence(c) {
  const byName = new Map();
  const add = (value, provenance, evidenceId, detailText = '') => {
    const anchor = text(value);
    if (!anchor) return;
    const key = anchor.toLowerCase();
    const detailMatch = detailText && new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegExp(anchor)}([^\\p{L}\\p{N}]|$)`, 'iu').test(detailText);
    const score = (provenance.kind === 'resume_project_technology' ? 2 : 1) + (detailMatch ? 5 : 0);
    const current = byName.get(key);
    if (!current || score > current.score) {
      byName.set(key, { anchor: compact(anchor, 80), evidenceId, provenance, score });
    }
  };

  c.skills.forEach((value, index) => add(
    value,
    { kind: 'resume_skill', recordIndex: index, field: 'skills' },
    c.skillEvidence[index]?.id || `skill_${index + 1}`
  ));

  c.projects.forEach((project, index) => {
    const details = `${project.description} ${project.title}`;
    project.technologies.forEach((value, technologyIndex) => add(
      value,
      { kind: 'resume_project_technology', recordIndex: index, field: 'technologies', itemIndex: technologyIndex },
      project.id,
      details
    ));
  });

  return [...byName.values()].sort((left, right) =>
    right.score - left.score || left.anchor.localeCompare(right.anchor)
  );
}

function projectEvidence(project, recordIndex) {
  if (project.title) {
    return {
      anchor: compact(project.title, 120),
      evidenceId: project.id,
      provenance: { kind: 'resume_project', recordIndex, field: 'title' },
    };
  }
  if (project.description) {
    return {
      anchor: compact(project.description, 120),
      evidenceId: project.id,
      provenance: { kind: 'resume_project', recordIndex, field: 'description' },
    };
  }
  if (project.technologies.length) {
    return {
      anchor: compact(project.technologies[0], 120),
      evidenceId: project.id,
      provenance: { kind: 'resume_project', recordIndex, field: 'technologies', itemIndex: 0 },
    };
  }
  return null;
}

function experienceEvidence(entry, recordIndex, fallbackSummary, slotIndex = recordIndex) {
  const responsibilityIndex = slotIndex % Math.max(entry.responsibilities.length, 1);
  const responsibility = entry.responsibilities[responsibilityIndex];
  const label = [entry.role, entry.organisation].filter(Boolean).join(' at ');

  if (label) {
    return {
      anchor: compact(label, 120),
      evidenceId: entry.id,
      provenance: {
        kind: 'resume_experience',
        recordIndex,
        field: entry.role ? 'role' : 'organisation',
        ...(responsibility ? { detailField: 'responsibilities', itemIndex: responsibilityIndex } : {}),
      },
      responsibility,
    };
  }

  if (responsibility) {
    return {
      anchor: compact(responsibility, 120),
      evidenceId: entry.id,
      provenance: { kind: 'resume_experience', recordIndex, field: 'responsibilities', itemIndex: responsibilityIndex },
      responsibility,
    };
  }

  if (fallbackSummary) {
    return {
      anchor: compact(fallbackSummary, 120),
      evidenceId: 'experience_summary',
      provenance: { kind: 'resume_experience_summary', field: 'experienceSummary' },
    };
  }

  return null;
}

function buildCategoryBlueprint(resumeContext, categoryId, interviewPlan = buildInterviewPlan(resumeContext), rotation = {}) {
  const category = getQuestionCategory(categoryId);
  if (!category) throw Object.assign(new Error('Invalid question category.'), { code: 'invalid-category' });

  const c = contextData(resumeContext);
  const plan = interviewPlan || buildInterviewPlan(resumeContext);
  const documentedCollaboration = [
    ...c.experience.flatMap((entry) => entry.responsibilities),
    ...c.projects.map((project) => project.description),
  ].some((value) =>
    /\b(team|teammate|collaborat\w*|coordinat\w*|communicat\w*|stakeholder|cross-functional|worked with|partner\w*|group)\b/i.test(value)
  );

  const projectDepthSets = [
    [
      'Explain the high-level architecture, important components, and how they interact in the documented project.',
      'Explain your own contribution, what you implemented, and how it fits into the project architecture.',
      'Trace a real request, user action, or data item end to end through the project.',
      'Explain the technologies selected for the project and the concrete trade-offs behind those choices.',
      'Describe a technical failure, debugging method, and how the implementation was tested.',
      'Identify an architectural limitation and how you would improve or scale the design.',
    ],
    [
      'Explain component boundaries and the responsibilities of major modules or services in the project.',
      'Explain why the project uses its documented frameworks, libraries, or data storage approach.',
      'Walk through the data model, persistence, or state changes in one important project flow.',
      'Discuss an integration point and how components exchange information or handle errors.',
      'Describe a meaningful edge case and how you would test the complete execution path.',
      'Discuss one important design decision you would revisit and its technical trade-offs.',
    ],
    [
      'Describe the system architecture and a possible bottleneck as project usage increases.',
      'Explain the most technically challenging component you owned and how it works internally.',
      'Trace authentication, validation, data flow, or another project-relevant cross-cutting concern.',
      'Compare the chosen tech stack against a plausible alternative and explain your decision.',
      'Explain how you debug failures between components and verify a fix.',
      'Discuss what you would change to make the project easier to maintain, deploy, or monitor.',
    ],
  ];
  const projectDepth = projectDepthSets[(rotation.generationIndex || 0) % projectDepthSets.length];
  const slots = getCategorySlots(category, plan.roleProfile).map((originalDefinition, slotIndex) => {
    const technicalAssessment = categoryId === 'technical_concepts' ? rotation.technicalAssessments?.[slotIndex] : null;
    const definition = technicalAssessment
      ? { id: originalDefinition.id, objective: technicalAssessment.assessmentObjective, assessmentTarget: technicalAssessment }
      : categoryId === 'project_deep_dive'
      ? { ...originalDefinition,
          objective: projectDepth[slotIndex] || originalDefinition.objective,
          questionExample: [
            'Can you explain the main components of this project and how they communicate?',
            'Which component did you implement, and how does it work internally?',
            'Walk me through what happens from a user request to the final result?',
            'Why did you choose the technologies used in this project over alternatives?',
            'What technical issue did you test or debug, and how did you verify the fix?',
            'Which architectural limitation would you address first, and why?',
          ][slotIndex],
        }
      : originalDefinition;
    if (categoryId === 'professional_experience' && definition.id === 'collaboration_coordination' && !documentedCollaboration) {
      return {
        ...definition,
        objective: 'How the candidate planned, organized, or tracked work when team collaboration is not documented.',
        questionExample: 'Can you tell me how you planned and tracked your own work on this project?',
      };
    }

    if (categoryId === 'behavioral_collaboration' && definition.id === 'team_collaboration' && !documentedCollaboration) {
      return {
        ...definition,
        objective: 'Without assuming a formal team, invite a real or hypothetical example about teamwork, communication, or asking for input.',
        questionExample: 'If a teammate is falling behind, how would you work with them to keep the task moving?',
      };
    }

    return definition;
  });

  const technologies = skillEvidence(c);
  const focusAreas = list(plan.focusAreas);
  const requiredFocusAreas = focusAreas.filter((area) => area.requiredSkillPriority);

  const projects = c.projects.map((project, index) => ({
    project,
    index,
    evidence: projectEvidence(project, index),
  })).sort((left, right) => {
    const relevance = ({ project }) => {
      const index = focusAreas.findIndex((area) =>
        [project.title, project.description, ...project.technologies]
          .some((claim) => claim && list(object(area).evidence).includes(claim))
      );
      return index < 0 ? focusAreas.length : index;
    };
    return relevance(left) - relevance(right) || left.index - right.index;
  }).filter((item) => item.evidence);

  const experienceRecords = c.experience.map((entry, index) => ({ entry, index }));

  const resolvedSlots = slots.map((definition, index) => {
    let evidence;
    let supportingEvidence;

    if (categoryId === 'domain_fundamentals') {
      evidence = {
        anchor: compact(c.targetRole, 80),
        evidenceId: c.targetRoleEvidenceId,
        provenance: { kind: 'role_fundamental', field: 'targetRole' },
      };
    } else if (categoryId === 'technical_concepts') {
      const assessment = object(definition.assessmentTarget);
      const targetName = text(assessment.primarySkill) || text(assessment.primaryAssessmentTarget) || c.targetRole;
      if (assessment.assessmentProvenance === 'required_skill') {
        evidence = { anchor: compact(targetName, 80), evidenceId: '',
          provenance: { kind: 'required_skill_assessment', field: 'requiredSkillset' } };
      } else if (assessment.assessmentProvenance === 'resume_skill') {
        const recordIndex = c.skills.findIndex((skill) => skill.toLowerCase() === targetName.toLowerCase());
        evidence = { anchor: compact(targetName, 80), evidenceId: c.skillEvidence[recordIndex]?.id || `skill_${recordIndex + 1}`,
          provenance: { kind: 'resume_skill', recordIndex, field: 'skills' } };
      } else if (assessment.assessmentProvenance === 'resume_project_technology') {
        const recordIndex = c.projects.findIndex((project) => project.technologies.some((technology) => technology.toLowerCase() === targetName.toLowerCase()));
        const itemIndex = recordIndex < 0 ? -1 : c.projects[recordIndex].technologies.findIndex((technology) => technology.toLowerCase() === targetName.toLowerCase());
        evidence = { anchor: compact(targetName, 80), evidenceId: c.projects[recordIndex]?.id || '',
          provenance: { kind: 'resume_project_technology', recordIndex, itemIndex, field: 'technologies' } };
      } else {
        evidence = { anchor: compact(c.targetRole, 80), evidenceId: c.targetRoleEvidenceId,
          provenance: { kind: 'role_fundamental', field: 'targetRole' } };
      }
    } else if (categoryId === 'project_deep_dive') {
      if (projects.length) {
        const projectIndex = Math.min(projects.length - 1, Math.floor(index * projects.length / slots.length));
        const selected = projects[projectIndex];
        evidence = selected.evidence;
        supportingEvidence = {
          title: selected.project.title,
          technologies: selected.project.technologies,
          description: compact(selected.project.description, 180),
        };
      } else {
        const skill = technologies[index % Math.max(technologies.length, 1)];
        evidence = skill || {
          anchor: compact(c.targetRole, 80),
          evidenceId: '',
          provenance: { kind: 'missing_resume_project', field: 'projects' },
        };
        supportingEvidence = { hypotheticalProject: true };
      }
    } else if (categoryId === 'professional_experience') {
      if (experienceRecords.length) {
        const recordPosition = Math.min(experienceRecords.length - 1, Math.floor(index * experienceRecords.length / slots.length));
        const selected = experienceRecords[recordPosition];
        evidence = experienceEvidence(selected.entry, selected.index, undefined, index);
        supportingEvidence = {
          role: selected.entry.role,
          organisation: selected.entry.organisation,
          responsibilities: selected.entry.responsibilities,
          selectedResponsibility: evidence?.responsibility,
          ...(definition.id === 'collaboration_coordination' ? { collaborationDocumented: documentedCollaboration } : {}),
        };
      } else if (projects.length) {
        const projectIndex = Math.min(projects.length - 1, Math.floor(index * projects.length / slots.length));
        const selected = projects[projectIndex];
        evidence = {
          ...selected.evidence,
          provenance: { ...selected.evidence.provenance, practicalExperience: true },
        };
        supportingEvidence = {
          title: selected.project.title,
          description: compact(selected.project.description, 180),
          practicalExperience: true,
          ...(definition.id === 'collaboration_coordination' ? { collaborationDocumented: documentedCollaboration } : {}),
        };
      } else if (c.experienceSummary) {
        evidence = {
          anchor: compact(c.experienceSummary, 120),
          provenance: { kind: 'resume_experience_summary', field: 'experienceSummary' },
        };
        supportingEvidence = {
          ...(definition.id === 'collaboration_coordination' ? { collaborationDocumented: documentedCollaboration } : {}),
        };
      } else {
        evidence = {
          anchor: compact(c.targetRole, 80),
          evidenceId: '',
          provenance: { kind: 'missing_resume_experience', field: 'experience' },
        };
      }
    } else if (categoryId === 'applied_scenarios') {
      const preferredTechnology = {
        // Backend scenarios
        api_latency: /\b(node(?:\.js)?|express|rest|api)\b/i,
        database_performance: /\b(mongo(?:db)?|sql|database|query|postgres|mysql)\b/i,
        access_control_failure: /\b(jwt|auth|token|express|node(?:\.js)?)\b/i,
        concurrent_updates: /\b(node(?:\.js)?|mongo(?:db)?|sql|concurr|thread)\b/i,
        integration_failure: /\b(express|socket(?:\.io)?|api|node(?:\.js)?)\b/i,
        incident_recovery: /\b(node(?:\.js)?|express|mongo(?:db)?|service|api)\b/i,
        // Full-stack scenarios
        client_api_mismatch: /\b(react|angular|vue|javascript|typescript|express|node(?:\.js)?|api|rest)\b/i,
        stale_interface_state: /\b(react|redux|angular|vue|javascript|typescript)\b/i,
        render_performance: /\b(react|angular|vue|javascript|typescript)\b/i,
        release_recovery: /\b(docker|aws|azure|gcp|node(?:\.js)?|react|express)\b/i,
        // Systems scenarios
        resource_exhaustion: /\b(c\+\+|rust|golang|go|java|linux|memory|pointer)\b/i,
        concurrent_access: /\b(c\+\+|rust|golang|go|java|thread|mutex)\b/i,
        operating_system_failure: /\b(c\+\+|rust|golang|go|java|linux|operating system)\b/i,
        performance_regression: /\b(c\+\+|rust|golang|go|java|python)\b/i,
        safe_recovery: /\b(c\+\+|rust|golang|go|java|linux)\b/i,
        // QA / test engineering scenarios
        regression_triage: /\b(jest|pytest|junit|selenium|playwright|cypress|postman|supertest)\b/i,
        flaky_automation: /\b(jest|pytest|junit|selenium|playwright|cypress)\b/i,
        api_contract_failure: /\b(postman|supertest|jest|pytest|api|rest)\b/i,
        edge_case_gap: /\b(jest|pytest|junit|selenium|playwright|cypress)\b/i,
        environment_integration: /\b(docker|node(?:\.js)?|python|java|jest|pytest)\b/i,
        release_verification: /\b(jest|pytest|junit|selenium|playwright|cypress|postman)\b/i,
        // Data engineering scenarios
        pipeline_data_quality: /\b(python|pandas|numpy|sql|mysql|postgres(?:ql)?|mongodb|spark|hadoop)\b/i,
        query_results: /\b(sql|mysql|postgres(?:ql)?|mongodb|database|pandas)\b/i,
        slow_query: /\b(sql|mysql|postgres(?:ql)?|mongodb|database)\b/i,
        concurrent_data_updates: /\b(sql|mysql|postgres(?:ql)?|mongodb|database)\b/i,
        source_format_change: /\b(python|pandas|numpy|sql|spark|hadoop)\b/i,
        pipeline_recovery: /\b(python|pandas|sql|spark|hadoop)\b/i,
        // AI / ML scenarios
        training_data_quality: /\b(python|pandas|numpy|scikit.learn|tensorflow|pytorch)\b/i,
        model_generalization: /\b(python|scikit.learn|tensorflow|pytorch)\b/i,
        model_evaluation: /\b(python|scikit.learn|tensorflow|pytorch)\b/i,
        inference_performance: /\b(python|scikit.learn|tensorflow|pytorch|onnx)\b/i,
        experiment_reproducibility: /\b(python|scikit.learn|tensorflow|pytorch|mlflow)\b/i,
        model_deployment_reliability: /\b(python|tensorflow|pytorch|docker|mlflow)\b/i,
        // Generic-role scenarios
        service_performance: /\b(node(?:\.js)?|express|api|rest|react|angular|vue)\b/i,
        data_correctness: /\b(mongo(?:db)?|sql|mysql|postgres|database|pandas)\b/i,
        concurrent_changes: /\b(mongo(?:db)?|sql|mysql|postgres|database|node(?:\.js)?)\b/i,
      }[definition.id];

      const matching = preferredTechnology
        ? technologies.filter((item) => preferredTechnology.test(item.anchor))
        : [];

      // Resume technologies are factual candidate evidence. Employer-required
      // skills are passed separately at blueprint level and are never relabelled
      // as skills the candidate has already demonstrated.
      evidence = matching.length
        ? matching[index % matching.length]
        : {
            anchor: compact(c.targetRole, 80),
            evidenceId: c.targetRoleEvidenceId,
            provenance: { kind: 'role_scenario', field: 'targetRole' },
          };
      supportingEvidence = { hypothetical: true };
    } else if (categoryId === 'behavioral_collaboration') {
      const entry = experienceRecords[index % Math.max(experienceRecords.length, 1)];
      const project = projects[index % Math.max(projects.length, 1)];
      if (entry) evidence = experienceEvidence(entry.entry, entry.index, undefined, index);
      else if (project) evidence = project.evidence;
      else evidence = { anchor: 'general', evidenceId: '', provenance: { kind: 'general_behavioral_prompt' } };
      supportingEvidence = { allowHypotheticalSituation: true, collaborationDocumented: documentedCollaboration };
    }

    // Attach the selected employer requirements to each slot as priority
    // guidance. They remain distinct from resume-derived supporting evidence.
    const technicalAssessment = categoryId === 'technical_concepts' ? object(definition.assessmentTarget) : {};
    const relevantRequiredSkills = categoryId === 'technical_concepts' && technicalAssessment.primaryRequiredSkill
      ? [technicalAssessment.primaryRequiredSkill] : c.requiredSkillset;

    return Object.freeze({
      slotId: definition.id,
      objective: definition.objective,
      ...(definition.questionExample ? { questionExample: definition.questionExample } : {}),
      evidence: Object.freeze({
        anchor: evidence?.anchor || compact(c.targetRole, 80),
        id: evidence?.evidenceId || '',
        provenance: Object.freeze(evidence?.provenance || { kind: 'role_context', field: 'targetRole' }),
      }),
      ...(supportingEvidence ? { supportingEvidence: Object.freeze(supportingEvidence) } : {}),
      ...(categoryId === 'technical_concepts' && c.requiredSkillset.length ? { assessmentSkill: relevantRequiredSkills[0] } : {}),
      ...(categoryId === 'technical_concepts' ? {
        primaryRequiredSkill: technicalAssessment.primaryRequiredSkill,
        primaryResumeSkill: technicalAssessment.primaryResumeSkill,
        primaryAssessmentTarget: technicalAssessment.primarySkill || technicalAssessment.primaryAssessmentTarget,
        relatedRequiredSkills: technicalAssessment.primaryRequiredSkill ? [technicalAssessment.primaryRequiredSkill] : [],
        subtopic: technicalAssessment.subtopic,
        keyTerms: technicalAssessment.keyTerms || [],
        assessmentObjective: technicalAssessment.assessmentObjective,
        questionStyle: technicalAssessment.questionStyle,
        difficulty: technicalAssessment.difficulty,
        assessmentCriteria: technicalAssessment.assessmentCriteria || [],
        skillKind: technicalAssessment.skillKind,
        skillConfidence: technicalAssessment.skillConfidence,
        assessmentProvenance: technicalAssessment.assessmentProvenance,
        coverageSignature: technicalAssessment.coverageSignature,
        coverageFallback: technicalAssessment.coverageFallback,
      } : {}),
      requiredSkillset: Object.freeze(relevantRequiredSkills.slice()),
      index,
    });
  });

  return Object.freeze({
    categoryId,
    role: c.targetRole,
    interviewType: c.interviewType,
    roleProfile: plan.roleProfile,
    domain: plan.primaryDomain,
    requiredSkillset: Object.freeze(c.requiredSkillset.slice()),
    requiredSkillEvidence: Object.freeze(c.requiredSkillEvidence.map((item) => Object.freeze({ ...item }))),
    requiredFocusAreas: Object.freeze(requiredFocusAreas.map((area) => Object.freeze({
      topic: area.topic,
      requiredSkills: Object.freeze(list(area.requiredSkills).slice()),
    }))),
    skillClassifications: Object.freeze(list(rotation.skillClassifications).map((item) => Object.freeze({
      name: text(object(item).name), kind: text(object(item).kind), confidence: Number(object(item).confidence) || 0,
    }))),
    slots: Object.freeze(resolvedSlots),
    hasProjects: projects.length > 0,
    hasExperience: experienceRecords.length > 0 || !!c.experienceSummary,
    hasPracticalExperience: experienceRecords.length > 0 || projects.length > 0 || !!c.experienceSummary,
    hasTechnicalEvidence: technologies.length > 0,
    hasRequiredSkillset: c.requiredSkillset.length > 0,
    hasRoleContext: c.targetRole !== 'Not specified',
    hasNamedProjects: projects.some((item) => Boolean(item.project.title)),
  });
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function categoryEvidencePreflight(blueprint) {
  if (blueprint.categoryId === 'technical_concepts' && !blueprint.hasTechnicalEvidence && !blueprint.hasRequiredSkillset && !blueprint.hasRoleContext) {
    return { slotIndex: 0, reason: 'missing-resume-skill' };
  }
  if (blueprint.categoryId === 'project_deep_dive' && !blueprint.hasProjects) {
    return { slotIndex: 0, reason: 'missing-resume-project' };
  }
  if (blueprint.categoryId === 'professional_experience' && !blueprint.hasPracticalExperience) {
    return { slotIndex: 0, reason: 'missing-resume-experience' };
  }
  return null;
}

module.exports = {
  buildCategoryBlueprint,
  categoryEvidencePreflight,
  contextData,
  compact,
  skillEvidence,
};
