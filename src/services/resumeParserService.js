/**
 * resumeParserService.js
 * -----------------------------------------------------------------------
 * Module 4 — Resume Processing & Resume Intelligence
 * Owner: Siddhant Raikar
 *
 * Responsibility: take cleaned resume text (from pdfService) and turn it
 * into a structured ParsedResume object — skills, projects, experience,
 * education — matching the class diagram's ResumeParserService:
 *   + extractSkills(text)      : String[]
 *   + extractProjects(text)    : Project[]
 *   + extractExperience(text)  : Experience[]
 *   + extractEducation(text)   : Education[]
 *   + parse(text)              : ParsedResume
 *
 * This is deliberately implemented with plain heuristics (regex + line
 * structure), NOT an LLM call — it needs to be fast, deterministic, and
 * work with zero external dependencies so it can be demoed offline. The
 * LLM step (ollamaService.js) runs *after* this, on top of its output, to
 * add judgment (summary, strengths, skill areas) that heuristics can't.
 * -----------------------------------------------------------------------
 */

// Section header aliases we recognise. Order matters only for readability;
// detection itself is order-independent (we find every header first, then
// slice between whichever two are closest together in the document).
const SECTION_ALIASES = {
  SKILLS: [
    'technical skills', 'core skills', 'skills & tools', 'skills and tools',
    'key skills', 'skills', 'technologies', 'tech stack',
  ],
  PROJECTS: [
    'academic projects', 'personal projects', 'key projects', 'major projects',
    'projects',
  ],
  EXPERIENCE: [
    'work experience', 'professional experience', 'internship experience',
    'internships', 'experience', 'employment history',
  ],
  EDUCATION: [
    'academic background', 'academic qualifications', 'educational qualifications',
    'education',
  ],
  CERTIFICATIONS: [
    'certifications', 'certificates', 'licenses & certifications', 'certification',
  ],
};

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;
const PHONE_RE = /(\+?\d{1,3}[-.\s]?)?\(?\d{3,5}\)?[-.\s]?\d{3,4}[-.\s]?\d{3,4}/;
const YEAR_RE = /\b(19|20)\d{2}\b/g;
// Splits a "Title - Subtitle" style line on a dash/colon/pipe that is
// surrounded by whitespace, so hyphenated words inside the title itself
// (e.g. "Real-Time Chat Application") are never mistaken for a separator.
const TITLE_SEPARATOR_RE = /\s[-–—]\s|:|\|/;
const DATE_RANGE_RE =
  /((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s*\d{4}|\d{1,2}\/\d{4}|\d{4})\s*(?:-|–|to)\s*((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s*\d{4}|\d{1,2}\/\d{4}|\d{4}|Present|Current)/i;
// Recognises a degree/qualification name so an education entry's two header
// lines can be told apart by CONTENT ("which one names the degree") rather
// than by position — different resume templates put institution-then-degree
// or degree-then-institution, in either order.
const DEGREE_KEYWORDS_RE =
  /\b(b\.?\s?tech|bachelor|diploma|b\.?\s?e\.?|m\.?\s?tech|master|ph\.?\s?d|integrated|higher secondary|hsc|ssc|associate|b\.?\s?sc|m\.?\s?sc|mba|bba|b\.?\s?com|m\.?\s?com)\b/i;
// Strips a trailing "CGPA: 8.7/10" or bare "91%" style metric off the end
// of a line, so it doesn't get glued onto the degree/institution text.
const METRIC_SUFFIX_RE =
  /[;,]?\s*(?:(?:CGPA|GPA)\s*:?\s*[\d.]+\s*(?:\/\s*\d+(?:\.\d+)?)?|\d{1,3}(?:\.\d+)?\s*%)\s*$/i;

/**
 * Finds every section header in the text and returns them in document order
 * as { section, line, index } — index is the character offset where the
 * header line starts, so we can slice the text between consecutive headers.
 */
function findSectionBoundaries(text) {
  const lines = text.split('\n');
  const boundaries = [];
  let offset = 0;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    const lineLower = line.toLowerCase().replace(/[:：]\s*$/, '').trim();

    if (line.length > 0 && line.length <= 45) {
      for (const [section, aliases] of Object.entries(SECTION_ALIASES)) {
        if (aliases.some((alias) => lineLower === alias || lineLower === alias.toUpperCase().toLowerCase())) {
          boundaries.push({ section, line, index: offset });
          break;
        }
      }
    }
    offset += rawLine.length + 1; // +1 for the \n that was split on
  }

  return boundaries;
}

/**
 * Slices the text into { SKILLS: "...", PROJECTS: "...", ... } bodies using
 * the boundaries found above. Anything before the first recognised header
 * is treated as the "contact/header block" the resume opens with.
 */
function sliceSections(text, boundaries) {
  const sections = {};
  const headerBlock = boundaries.length
    ? text.slice(0, boundaries[0].index)
    : text;

  for (let i = 0; i < boundaries.length; i += 1) {
    const current = boundaries[i];
    const next = boundaries[i + 1];
    const start = current.index + current.line.length;
    const end = next ? next.index : text.length;
    const body = text.slice(start, end).trim();

    // A resume can repeat the same section heading in odd formats; keep
    // the longest body found for a given section rather than overwriting
    // with a shorter accidental duplicate match.
    if (!sections[current.section] || body.length > sections[current.section].length) {
      sections[current.section] = body;
    }
  }

  return { headerBlock, sections };
}

/**
 * A raw block, split naively on blank lines, first.
 */
function splitOnBlankLines(block) {
  if (!block) return [];
  return block
    .split(/\n\s*\n/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/**
 * True if `block` looks like a *continuation* of the previous entry rather
 * than the start of a new one — e.g. a "Tech: React, Node.js" line, or a
 * bullet point, that PDF-to-text layout conversion separated with extra
 * blank-line spacing from the paragraph it actually belongs to. Different
 * PDF producers (reportlab, Word, LaTeX, Canva) leave very different
 * amounts of whitespace between lines, so relying on blank-line splitting
 * alone is not reliable enough on its own — this is the safety net.
 */
function looksLikeContinuation(block) {
  const firstLine = block.split('\n')[0].trim();
  if (/^(tech|stack|tools?|technologies)\s*:/i.test(firstLine)) return true;
  if (/^[-*•]/.test(firstLine)) return true;
  if (/^[a-z]/.test(firstLine)) return true; // continues a sentence in lowercase
  return false;
}

/**
 * Splits a block of text into "entries" — paragraphs separated by one or
 * more blank lines, which is how most resumes separate projects, jobs and
 * degrees from each other — then re-merges any entry that actually looks
 * like a continuation of the one before it (see looksLikeContinuation).
 */
function splitIntoEntries(block) {
  const rawEntries = splitOnBlankLines(block);
  const merged = [];

  for (const entry of rawEntries) {
    if (merged.length > 0 && looksLikeContinuation(entry)) {
      merged[merged.length - 1] += '\n' + entry;
    } else {
      merged.push(entry);
    }
  }

  return merged;
}

/**
 * True if `line` is a bullet point. Handles the common bullet glyphs after
 * cleanText() has normalised them to "- " prefixes.
 */
function isBulletLine(line) {
  return /^[-*•]\s+\S/.test(line);
}

/**
 * Some PDF extractions put a bullet glyph on its own line, with the actual
 * bullet text on the *next* line (the glyph and the text were separate text
 * runs in the PDF that just happen to sit on consecutive lines). This finds
 * those bare "-" marker lines and folds them back into a single "- text"
 * line so the rest of the parsing logic sees one bullet per line, same as
 * every other PDF producer.
 */
function mergeBareBulletMarkers(lines) {
  const out = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line === '-' && i + 1 < lines.length) {
      out.push(`- ${lines[i + 1]}`);
      i += 1; // consume the next line too
    } else {
      out.push(line);
    }
  }
  return out;
}

/**
 * Structural fallback for when a whole section came through as a single
 * block with no blank lines at all between entries — common with many
 * real-world PDF exports (Word, Canva, LaTeX templates), where pdf-parse /
 * pdftotext only preserve line breaks, not paragraph spacing. Without a
 * blank line to split on, entries are told apart by structure instead:
 * every entry gets up to `maxHeaderLines` non-bullet lines (its title /
 * role / degree line, and optionally one more detail line), followed by
 * zero or more bullet lines. Recognized headings and date ranges start a
 * new entry; other lines after bullets are treated as wrapped descriptions.
 */
function splitStructuredEntries(lines, maxHeaderLines, isHeading = () => false) {
  const entries = [];
  let headerLines = [];
  let bulletLines = [];

  function flush() {
    if (headerLines.length > 0) {
      entries.push([...headerLines, ...bulletLines].join('\n'));
    }
    headerLines = [];
    bulletLines = [];
  }

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex];
    if (isBulletLine(line)) {
      if (headerLines.length > 0) bulletLines.push(line);
      continue;
    }

    if (headerLines.length > 0 && isHeading(line, lines[lineIndex + 1])) {
      flush();
      headerLines.push(line);
    } else if (headerLines.length > 0 && bulletLines.length === 0 && headerLines.length < maxHeaderLines) {
      headerLines.push(line);
    } else if (bulletLines.length > 0 && !DATE_RANGE_RE.test(line)) {
      // A long bullet point that line-wrapped in the PDF has no bullet
      // marker on its second physical line — it's a continuation of the
      // last bullet, not a new entry. A date range is still treated as a
      // strong "new entry" signal even here, since a wrapped bullet line
      // essentially never contains one.
      bulletLines[bulletLines.length - 1] += ' ' + line;
    } else {
      flush();
      headerLines.push(line);
    }
  }
  flush();

  return entries;
}

/**
 * Splits a section into entry blocks. Blank-line spacing between entries
 * turns out *not* to be a reliable signal in real PDF exports — some
 * producers leave blank-line-equivalent gaps around every bullet too, not
 * just between entries — so this always uses the structural, line-based
 * splitter instead. The one thing that genuinely tells "still the same
 * entry" from "new entry" apart is whether bullets are involved:
 *   - If the section uses bullets, header lines accumulate until bullets
 *     appear. Recognized headings/date ranges then start the next entry;
 *     other non-bullet lines continue the preceding bullet.
 *   - If the section never uses bullets (e.g. Education, Certifications,
 *     or a template that writes projects as plain paragraphs with no
 *     bullet list), there's no such signal, so `noBulletCap` bounds how
 *     many header lines belong to one entry before a new one starts.
 */
function getEntryBlocks(sectionText, noBulletCap, isHeading) {
  if (!sectionText) return [];
  const lines = mergeBareBulletMarkers(
    sectionText.split('\n').map((l) => l.trim()).filter((l) => l.length > 0)
  );
  const hasBullets = lines.some(isBulletLine);
  const cap = hasBullets ? Infinity : noBulletCap;
  return splitStructuredEntries(lines, cap, isHeading);
}

// ---------------------------------------------------------------------------
// extractSkills
// ---------------------------------------------------------------------------
function extractSkills(sectionText) {
  if (!sectionText) return [];

  const tokens = sectionText
    .split(/\n|,|•|\||;/)
    .map((t) => t.replace(/^[-*•\s]+/, '').trim())
    .filter((t) => t.length > 0 && t.length < 40)
    // drop category labels like "Languages:" that sometimes prefix a line
    .map((t) => t.replace(/^[A-Za-z &/]+:\s*/, ''))
    .flatMap((t) => (t.includes(':') ? t.split(':').pop() : t))
    .flatMap((t) => t.split(/,/))
    .map((t) => t.trim())
    .filter((t) => t.length > 1 && t.length < 30);

  // De-duplicate case-insensitively while preserving first-seen casing.
  const seen = new Map();
  for (const t of tokens) {
    const key = t.toLowerCase();
    if (!seen.has(key)) seen.set(key, t);
  }
  return Array.from(seen.values());
}

// ---------------------------------------------------------------------------
// extractProjects
// ---------------------------------------------------------------------------
const TECH_LINE_RE = /^(tech|stack|tools?|technologies)\s*:/i;

function isProjectHeading(line, nextLine = '') {
  if (TECH_LINE_RE.test(line) || line.length > 250) return false;
  // A title with an explicit stack separator is a stronger boundary than line wrapping.
  const pipe = line.indexOf('|');
  if (pipe > 0 && pipe < 101 && /^[A-Z0-9]/.test(line) && !/[.!?]$/.test(line.slice(0, pipe).trim())) return true;
  if (TECH_LINE_RE.test(nextLine) && /^[A-Z0-9]/.test(line)) return true;
  // Short title-case headings without a stack, followed by a bullet, are also common.
  const titleWords = line.split(/\s+/);
  return isBulletLine(nextLine) && titleWords.length >= 2 && titleWords.length <= 10 &&
    !/[.!?:]$/.test(line) && titleWords.every((word) => /^(?:[A-Z0-9]|[-\u2013\u2014])/.test(word) || /^(of|and|for|the|with|in|a)$/i.test(word));
}

function extractProjects(sectionText) {
  // Bulleted entries need only 1 header line (see getEntryBlocks); a
  // no-bullet fallback (plain-paragraph style templates, e.g. title +
  // wrapped description + a "Tech:" line) gets a slightly higher cap.
  const entries = getEntryBlocks(sectionText, 4, isProjectHeading);

  return entries.map((entry) => {
    const lines = entry.split('\n').map((l) => l.trim()).filter(Boolean);
    const titleLine = lines[0] || '';

    // Some resumes put the date range directly on the title line, often
    // butted right up against the tech list with no space in between
    // (a PDF text-extraction artifact, e.g. "...Power BI, SQLJan 2026 –
    // May 2026") — pull it out before splitting the rest of the line.
    const dateMatch = titleLine.match(DATE_RANGE_RE);
    const duration = dateMatch ? `${dateMatch[1]} - ${dateMatch[2]}` : '';
    const titleLineWithoutDate = dateMatch
      ? titleLine.replace(dateMatch[0], '').trim()
      : titleLine;

    // Title is usually before a dash/colon/pipe, or the whole first line.
    // Whatever follows the separator (if anything) is often an inline tech
    // list, e.g. "Title| Python, Flask, Docker".
    const headerParts = titleLineWithoutDate.split(titleLineWithoutDate.includes('|') ? /\|/ : TITLE_SEPARATOR_RE)
      .map((p) => p.trim()).filter(Boolean);
    const title = (headerParts[0] || '').slice(0, 100);
    const inlineTechList = headerParts[1]
      ? headerParts[1].split(/,|•/).map((t) => t.trim()).filter(Boolean)
      : [];

    const bodyLines = lines.slice(1);
    const description = bodyLines
      .filter((l) => !TECH_LINE_RE.test(l))
      .map((l) => l.replace(/^[-*•\s]+/, '').trim())
      .join(' ')
      .trim();

    const techLine = lines.find((l) => TECH_LINE_RE.test(l));
    const technologies = techLine
      ? techLine.replace(TECH_LINE_RE, '').split(/,|\||•/).map((t) => t.trim()).filter(Boolean)
      : inlineTechList;

    return { title, description, technologies, duration };
  }).filter((p) => p.title.length > 0);
}

// ---------------------------------------------------------------------------
// extractExperience
// ---------------------------------------------------------------------------
function cleanOrganisation(value) {
  // Repair the clear PDF column-join artifact "CompanyRemote" without stripping
  // words inside names such as "Remote Labs" or "RemoteWorks".
  return value.replace(/([a-z0-9])Remote$/, '$1')
    .replace(/\s*[|,]\s*(?:Remote|[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*,\s*India)$/i, '')
    .trim();
}

function extractExperience(sectionText) {
  const entries = getEntryBlocks(sectionText, 2);

  return entries.map((entry) => {
    const lines = entry.split('\n').map((l) => l.trim()).filter(Boolean);
    const headerLine = lines[0] || '';

    const dateMatch = entry.match(DATE_RANGE_RE);
    const duration = dateMatch ? `${dateMatch[1]} - ${dateMatch[2]}` : '';

    // The date can be on the header line itself, sometimes with no space
    // before it (e.g. "...InternJan 2024 – Jun 2024") — strip it out
    // before splitting the line into role/organisation.
    const headerWithoutDate = dateMatch && headerLine.includes(dateMatch[0])
      ? headerLine.replace(dateMatch[0], '').trim()
      : headerLine;

    // Header line is commonly "Role — Organisation" or "Role, Organisation"
    // on one line. If not, real resumes often put the role on its own line
    // and the organisation on the next — use that if there is one.
    const headerParts = headerWithoutDate.split(/\s[-–—]\s|,|\|/).map((p) => p.trim()).filter(Boolean);

    let role;
    let organisation;
    let bodyStartIndex;

    if (headerParts.length > 1) {
      role = headerParts[0];
      organisation = headerParts[1];
      bodyStartIndex = 1;
    } else {
      role = headerWithoutDate;
      const secondLine = lines[1] || '';
      if (secondLine && !isBulletLine(secondLine) && !DATE_RANGE_RE.test(secondLine)) {
        organisation = secondLine;
        bodyStartIndex = 2;
      } else {
        organisation = '';
        bodyStartIndex = 1;
      }
    }

    organisation = cleanOrganisation(organisation);
    // With bullets, all preceding lines are heading metadata (dates/location).
    const firstBullet = lines.findIndex(isBulletLine);
    const responsibilities = lines
      .slice(firstBullet >= 0 ? firstBullet : bodyStartIndex)
      .filter((l) => !DATE_RANGE_RE.test(l))
      .map((l) => l.replace(/^[-*•\s]+/, '').trim())
      .filter(Boolean);

    return { role, organisation, duration, responsibilities };
  }).filter((e) => e.role.length > 0);
}

// ---------------------------------------------------------------------------
// extractEducation
// ---------------------------------------------------------------------------
function extractEducation(sectionText) {
  const entries = getEntryBlocks(sectionText, 2);

  return entries.map((entry) => {
    const rawLines = entry.split('\n').map((l) => l.trim()).filter(Boolean);

    const years = entry.match(YEAR_RE) || [];
    const year = years.length ? years[years.length - 1] : '';

    // Strip the date range (if any) and any trailing CGPA/percentage off
    // each header line individually, so whichever line has them doesn't
    // matter — the cleanup is applied uniformly either way.
    const cleanedLines = rawLines.map((line) => {
      const dateMatch = line.match(DATE_RANGE_RE);
      let cleaned = dateMatch ? line.replace(dateMatch[0], '').trim() : line;
      cleaned = cleaned.replace(METRIC_SUFFIX_RE, '').replace(/[;,]\s*$/, '').trim();
      return cleaned;
    });

    // Different templates put the degree and institution in different
    // places — "Degree - Institution" combined on one line with dates/CGPA
    // on the next, or "Institution" on one line with "Degree; CGPA; dates"
    // on the next. Tell them apart by which cleaned line actually names a
    // degree/qualification, not by position.
    const degreeIndex = cleanedLines.findIndex((l) => DEGREE_KEYWORDS_RE.test(l));

    let degree;
    let institution;

    if (degreeIndex !== -1 && cleanedLines.length > 1) {
      const degreeLine = cleanedLines[degreeIndex];
      const otherLine = cleanedLines.find((l, i) => i !== degreeIndex && l.length > 0);

      if (otherLine && !DEGREE_KEYWORDS_RE.test(otherLine)) {
        // The other line is a clean institution name on its own.
        degree = degreeLine;
        institution = otherLine;
      } else {
        // No separate institution line (it was empty after stripping dates/
        // CGPA, or it also reads like a degree) — this is a single combined
        // "Degree - Institution" line; split it the old way.
        const parts = degreeLine.split(TITLE_SEPARATOR_RE).map((p) => p.trim()).filter(Boolean);
        degree = parts[0] || degreeLine;
        institution = parts.slice(1).join(', ') || otherLine || '';
      }
    } else {
      // No line clearly names a degree — fall back to treating line 1 as
      // the degree (possibly "Degree - Institution" combined) and line 2
      // (if present) as the institution.
      const headerLine = cleanedLines[0] || '';
      const parts = headerLine.split(TITLE_SEPARATOR_RE).map((p) => p.trim()).filter(Boolean);
      if (parts.length > 1) {
        degree = parts[0];
        institution = parts.slice(1).join(', ');
      } else {
        degree = headerLine;
        institution = cleanedLines[1] || '';
      }
    }

    return { degree, institution, year };
  }).filter((e) => e.degree.length > 0);
}

// ---------------------------------------------------------------------------
// Contact block (name / email / phone) — used for the candidate profile,
// not a rubric-required field, but genuinely useful for the demo.
// ---------------------------------------------------------------------------
function extractContactInfo(headerBlock, fullText) {
  const source = headerBlock && headerBlock.trim().length > 0 ? headerBlock : fullText.slice(0, 500);
  const lines = source.split('\n').map((l) => l.trim()).filter(Boolean);

  const email = (fullText.match(EMAIL_RE) || [])[0] || '';
  const phone = (fullText.match(PHONE_RE) || [])[0] || '';

  // Best-effort name guess: first line that isn't the email/phone and isn't
  // itself too long to plausibly be a person's name.
  const name = lines.find(
    (l) => l.length > 0 && l.length < 45 && !EMAIL_RE.test(l) && !PHONE_RE.test(l)
  ) || '';

  return { name, email, phone };
}

/**
 * Main entry point — mirrors `+ parse(text) : ParsedResume` on the class
 * diagram. Runs every extractor and assembles the ParsedResume object that
 * the rest of the pipeline (LLM analysis, question generation) consumes.
 */
function parse(text) {
  const boundaries = findSectionBoundaries(text);
  const { headerBlock, sections } = sliceSections(text, boundaries);

  const skills = extractSkills(sections.SKILLS);
  const projects = extractProjects(sections.PROJECTS);
  const experience = extractExperience(sections.EXPERIENCE);
  const education = extractEducation(sections.EDUCATION);
  const certifications = sections.CERTIFICATIONS
    ? getEntryBlocks(sections.CERTIFICATIONS, 1).map((e) => e.split('\n')[0].trim())
    : [];
  const contact = extractContactInfo(headerBlock, text);

  const sectionsFound = boundaries.map((b) => b.section);
  const warnings = [];
  if (!sectionsFound.includes('SKILLS')) warnings.push('No "Skills" section was detected.');
  if (!sectionsFound.includes('PROJECTS')) warnings.push('No "Projects" section was detected.');
  if (!sectionsFound.includes('EXPERIENCE')) warnings.push('No "Experience" section was detected (this is common for students with no prior internship).');
  if (!sectionsFound.includes('EDUCATION')) warnings.push('No "Education" section was detected.');

  return {
    contact,
    skills,
    projects,
    experience,
    education,
    certifications,
    meta: {
      sectionsDetected: [...new Set(sectionsFound)],
      warnings,
      rawTextLength: text.length,
    },
  };
}

module.exports = {
  parse,
  extractSkills,
  extractProjects,
  extractExperience,
  extractEducation,
  findSectionBoundaries, // exported for unit tests / debugging in the demo
  SECTION_ALIASES,
};
