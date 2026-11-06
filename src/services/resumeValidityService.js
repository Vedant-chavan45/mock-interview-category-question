/** Deterministic first-line defense against non-resume PDFs.
 *  This is a conservative heuristic, not a proof that a document is genuine.
 *  Only use PDF-extracted text and parsed structure; NEVER ask Groq to classify
 *  arbitrary uploads before they have passed the gate.
 */
const CORE_SECTIONS = ['SKILLS', 'PROJECTS', 'EXPERIENCE', 'EDUCATION'];
const DEGREE = /\b(?:b\.?\s?tech|bachelor|b\.?\s?e\.?|diploma|b\.?\s?sc|master|m\.?\s?tech|m\.?\s?sc|mba|ph\.?d|university|college|school)\b/i;
const BAD_DOCUMENT_HEADINGS = /^(?:experiment\s+\d+|assignment\s*\d*|table of contents|abstract|question paper|laboratory manual|user guide|invoice|receipt|research article|research paper|chapter\s+\d+)\b/i;

class NotAResumeError extends Error {
  constructor() {
    super('This PDF does not appear to be a resume/CV. Upload a resume with sections such as Education, Skills, Projects or Experience.');
    this.name = 'NotAResumeError';
    this.statusCode = 422;
    this.code = 'NOT_A_RESUME';
  }
}

function inspectResume(text, parsed) {
  const sections = new Set(parsed?.meta?.sectionsDetected || []);
  const coreCount = CORE_SECTIONS.filter(section => sections.has(section)).length;
  const skills = Array.isArray(parsed?.skills) ? parsed.skills.filter(s => typeof s === 'string' && s.length > 1) : [];
  const education = Array.isArray(parsed?.education) ? parsed.education : [];
  const experience = Array.isArray(parsed?.experience) ? parsed.experience : [];
  const projects = Array.isArray(parsed?.projects) ? parsed.projects : [];
  const hasEducation = sections.has('EDUCATION') && education.some(entry =>
    DEGREE.test(`${entry.degree || ''} ${entry.institution || ''}`));
  const hasExperience = sections.has('EXPERIENCE') && experience.some(entry =>
    Boolean(entry.role && (entry.organisation || entry.responsibilities?.length)));
  const hasProjects = sections.has('PROJECTS') && projects.some(entry =>
    Boolean(entry.title && (entry.description || entry.technologies?.length)));
  const hasSkills = sections.has('SKILLS') && skills.length >= 2;
  const contact = parsed?.contact || {};
  const plausibleName = typeof contact.name === 'string' &&
    /^[\p{L}][\p{L} .'-]{2,64}$/u.test(contact.name) &&
    contact.name.trim().split(/\s+/).length <= 6 &&
    !BAD_DOCUMENT_HEADINGS.test(contact.name.trim());
  const hasIdentity = Boolean(plausibleName || contact.email || contact.phone);
  const hasContent = [hasEducation, hasExperience, hasProjects].filter(Boolean).length >= 1;
  // A resume may omit Education or Experience, but must still provide multiple
  // recognizable types of *substantive* career/profile evidence.
  const substantiated = [hasEducation, hasExperience, hasProjects, hasSkills].filter(Boolean).length;
  const rejected = coreCount < 2 || substantiated < 2 || !hasContent || !hasIdentity;
  return { valid: !rejected, signals: { coreCount, substantiated, hasEducation, hasExperience,
    hasProjects, hasSkills, hasIdentity } };
}

function validateResume(text, parsed) {
  const result = inspectResume(text, parsed);
  if (!result.valid) throw new NotAResumeError();
  return result;
}

module.exports = { inspectResume, validateResume, NotAResumeError };
