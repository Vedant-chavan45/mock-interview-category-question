/** Development-only service-layer evaluation. No application server or database imports. */
require('dotenv').config();
const fs = require('node:fs/promises');
const path = require('node:path');
const pdfService = require('../src/services/pdfService');
const parser = require('../src/services/resumeParserService');
const ollama = require('../src/services/ollamaService');
const contextBuilder = require('../src/services/contextBuilder');
const { buildInterviewPlan } = require('../src/services/interviewPlannerService');
const { generateQuestions } = require('../src/services/questionGeneratorService');

const ROLES = ['Backend Developer', 'Full Stack Developer', 'C++ Developer', 'QA Engineer'];
const normalize = (value) => value.toLowerCase().trim().replace(/\s+/g, ' ').replace(/[.!?,;:]+$/, '').trim();

function concreteAnchors(context) {
  // Excludes role requirements, planner topics, and inferred analysis claims.
  return [
    ...context.skills,
    ...context.projects.flatMap((p) => [p.title, p.description, ...p.technologies]),
    ...context.experience.flatMap((e) => [e.role, e.organisation, ...e.responsibilities]),
    ...context.education.flatMap((e) => [e.degree, e.institution, e.year]),
  ].filter((v) => typeof v === 'string' && v.trim()).map(normalize);
}

function summarize(result, context) {
  const anchors = concreteAnchors(context);
  const counts = { technical: 0, project: 0, experience: 0, behavioral: 0 };
  let grounded = 0;
  for (const q of result.questions) {
    counts[q.type] += 1;
    const basedOn = normalize(q.basedOn);
    if (anchors.some((anchor) => {
      const index = basedOn.indexOf(anchor);
      if (index < 0) return false;
      const before = basedOn[index - 1] || '';
      const after = basedOn[index + anchor.length] || '';
      return !/[\p{L}\p{N}+#]/u.test(before) && !/[\p{L}\p{N}+#]/u.test(after);
    })) grounded += 1;
  }
  return { total: result.questions.length, counts,
    distinct: new Set(result.questions.map((q) => normalize(q.question))).size, grounded };
}

function sourceLabel(source) {
  return source === 'ollama-llama3.2' ? 'AI (ollama-llama3.2)' : 'heuristic fallback';
}

function printRole({ role, plan, result }) {
  console.log(`\n${'='.repeat(60)}\nROLE: ${role}\nDOMAIN: ${plan.primaryDomain}`);
  console.log(`INTERVIEW TYPE: ${plan.interviewType}\nSOURCE: ${sourceLabel(result.source)}\n${'='.repeat(60)}`);
  console.log('\nFOCUS AREAS');
  plan.focusAreas.forEach((area, i) => {
    console.log(`\n${i + 1}. ${area.topic} [${area.priority.toUpperCase()}]\n   Evidence:`);
    if (!area.evidence.length) console.log('   - none supplied (role fundamentals only)');
    area.evidence.forEach((evidence) => console.log(`   - ${evidence}`));
  });
  console.log('\nQUESTIONS');
  result.questions.forEach((q, i) => {
    console.log(`\n${i + 1}. [${q.type}]\n   ${q.question}\n   Based on: ${q.basedOn}`);
  });
}

function parseEvaluationArgs(args) {
  if (args.length === 1 && args[0] && !args[0].startsWith('--')) return { pdfPath: args[0], roles: [...ROLES] };
  if (args.length !== 3 || !args[0] || args[0].startsWith('--') || args[1] !== '--role') {
    throw new Error('Usage: npm run evaluate:questions -- path/to/resume.pdf [--role "Backend Developer"]');
  }
  const role = ROLES.find((value) => value.toLowerCase() === args[2].trim().toLowerCase());
  if (!role) throw new Error(`Unsupported role. Choose: ${ROLES.join(', ')}.`);
  return { pdfPath: args[0], roles: [role] };
}

async function main(args = process.argv.slice(2)) {
  let selection;
  try {
    selection = parseEvaluationArgs(args);
  } catch (error) {
    console.error(error.message); // Only fixed CLI usage/role messages, never raw input.
    process.exitCode = 1;
    return;
  }
  let buffer;
  try {
    const stat = await fs.stat(selection.pdfPath);
    if (!stat.isFile()) throw new Error('Not a file');
    pdfService.validateFile({ size: stat.size,
      mimetype: path.extname(selection.pdfPath).toLowerCase() === '.pdf' ? 'application/pdf' : 'application/octet-stream' });
    buffer = await fs.readFile(selection.pdfPath);
  } catch (error) {
    console.error(error instanceof pdfService.UnreadableResumeError
      ? 'PDF rejected: supply a PDF within the existing 5 MB limit.'
      : 'Cannot read the PDF. Check that the file exists and is readable.');
    process.exitCode = 1;
    return;
  }
  const { text, pageCount } = await pdfService.extractText(buffer);
  const parsed = parser.parse(text);
  console.log(`Resume extracted once: ${pageCount} page(s), ${parsed.skills.length} skills, ` +
    `${parsed.projects.length} projects, ${parsed.experience.length} experience entries.`);
  console.log('Analysing resume once; existing Ollama timeouts and fallback apply.');
  const analysis = await ollama.analyseResume(parsed);
  console.log(`Analysis source: ${sourceLabel(analysis.source)}`);
  const reports = [];
  for (const role of selection.roles) {
    console.log(`\nGenerating questions for ${role}...`);
    const context = contextBuilder.build(parsed, analysis, { interviewType: 'Technical', targetRole: role });
    const plan = buildInterviewPlan(context);
    const result = await generateQuestions(context);
    const report = { role, plan, result, summary: summarize(result, context) };
    reports.push(report);
    printRole(report);
  }
  console.log('\nQUALITY SUMMARY');
  console.log('Concrete grounding = basedOn contains a complete structured resume anchor (case-insensitive).');
  console.log('This is an inspection count, not proof of factual accuracy or a quality score.');
  for (const { role, result, summary: s } of reports) {
    console.log(`\n${role}: total=${s.total}; distinct=${s.distinct}; concrete grounding=${s.grounded}/${s.total}`);
    console.log(`  Types: ${Object.entries(s.counts).map(([type, count]) => `${type}=${count}`).join(', ')}`);
    console.log(`  Source: ${sourceLabel(result.source)}`);
  }
  console.log('\nROLE DIFFERENTIATION (top three topics in planner order)');
  for (const { role, plan } of reports) {
    console.log(`${role}: ${plan.focusAreas.slice(0, 3).map((a) => a.topic).join(', ')}`);
  }
  for (let i = 0; i < reports.length; i += 1) {
    for (let j = i + 1; j < reports.length; j += 1) {
      const topics = (r) => r.plan.focusAreas.slice(0, 3).map((a) => a.topic).sort().join('|');
      console.log(`  ${reports[i].role} vs ${reports[j].role}: ` +
        (topics(reports[i]) === topics(reports[j]) ? 'same top topic set' : 'different top topic sets'));
    }
  }
  if (reports.some((r) => r.result.source === 'heuristic-fallback')) {
    console.log('\nFallback roles did not evaluate live AI quality. Fallback may mean Ollama was unavailable, timed out, or returned invalid output.');
  }
}

if (require.main === module) {
  main().catch((error) => {
    // Never dump request/config objects, model errors, or environment credentials.
    console.error(error instanceof pdfService.UnreadableResumeError
      ? 'Resume could not be processed: no usable PDF text was extracted (scans may require OCR).'
      : 'Evaluation failed. Check the PDF and local service setup.');
    process.exitCode = 1;
  });
}

module.exports = { summarize, main, parseEvaluationArgs };
