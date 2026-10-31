/**
 * contextBuilder.js
 * -----------------------------------------------------------------------
 * Module 4 — Resume Processing & Resume Intelligence
 * Owner: Siddhant Raikar
 *
 * Responsibility: matches the class diagram's QuestionContextBuilder.
 *   + build(resume, type, role) : ResumeContext
 *
 * Takes the ParsedResume (from resumeParserService) plus the LLM analysis
 * (from ollamaService) and the candidate's chosen interview type/role, and
 * packages them into the single ResumeContext object that is the actual
 * hand-off point to the Interview module (Module 1/3) — this is the
 * concrete integration boundary described in the module dependency slide:
 * "Siddhant → provides processed resume context for personalised AI
 * question generation."
 * -----------------------------------------------------------------------
 */

function build(parsedResume, analysis, { interviewType = 'Technical', targetRole = '' } = {}) {
  const experience = Array.isArray(parsedResume.experience) ? parsedResume.experience : [];
  const skills = Array.isArray(parsedResume.skills) ? parsedResume.skills : [];
  const projects = Array.isArray(parsedResume.projects) ? parsedResume.projects : [];
  const education = Array.isArray(parsedResume.education) ? parsedResume.education : [];
  const certifications = Array.isArray(parsedResume.certifications) ? parsedResume.certifications : [];
  return {
    skills,
    projects: projects.map((p) => ({
      title: p.title,
      description: p.description,
      technologies: p.technologies,
    })),
    experience: experience.map((e) => ({
      role: e.role,
      organisation: e.organisation,
      duration: e.duration,
      responsibilities: e.responsibilities,
    })),
    experienceSummary: experience
      .map((e) => `${e.role}${e.organisation ? ' at ' + e.organisation : ''}${e.duration ? ' (' + e.duration + ')' : ''}`)
      .join('; '),
    education,
    certifications,
    candidateSummary: analysis.summary,
    strengths: analysis.strengths,
    skillAreasToProbe: analysis.skillAreasToProbe,
    interviewType,
    targetRole,
    analysisSource: analysis.source, // 'ollama-llama3.2' or 'heuristic-fallback' — surfaced, not hidden
    structuredEvidence: {
      targetRole: { id: 'role_target', value: targetRole || 'Software Engineer' },
      skills: skills.map((name, index) => ({ id: `skill_${index + 1}`, name })),
      projects: projects.map((project, index) => ({ id: `project_${index + 1}`, ...project })),
      experience: experience.map((entry, index) => ({ id: `experience_${index + 1}`, ...entry })),
      education: education.map((entry, index) => ({ id: `education_${index + 1}`, ...entry })),
      certifications: certifications.map((name, index) => ({ id: `certification_${index + 1}`, name })),
    },
  };
}

module.exports = { build };
