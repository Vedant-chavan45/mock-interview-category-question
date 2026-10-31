/**
 * parseSample.js
 * -----------------------------------------------------------------------
 * Module 4 — Resume Processing & Resume Intelligence — offline demo CLI
 * Owner: Siddhant Raikar
 *
 * This is the recommended way to demo the module to a mentor: it runs
 * the exact same pdfService -> resumeParserService -> ollamaService ->
 * contextBuilder pipeline as the live API, but as a plain CLI script.
 * No server, no Postman, no network dependency other than an *optional*
 * local Ollama call that fails gracefully if it's not running.
 *
 * Usage:
 *   node test/parseSample.js                     (uses test/sample_resume.pdf)
 *   node test/parseSample.js path/to/resume.pdf   (uses your own PDF)
 * -----------------------------------------------------------------------
 */

const fs = require('fs');
const path = require('path');

const pdfService = require('../src/services/pdfService');
const resumeParserService = require('../src/services/resumeParserService');
const ollamaService = require('../src/services/ollamaService');
const contextBuilder = require('../src/services/contextBuilder');

function section(title) {
  console.log('\n' + '='.repeat(70));
  console.log(title);
  console.log('='.repeat(70));
}

async function main() {
  const pdfPath = process.argv[2] || path.join(__dirname, 'sample_resume.pdf');

  if (!fs.existsSync(pdfPath)) {
    console.error(`\nNo PDF found at: ${pdfPath}`);
    console.error('Generate the sample first with:  python3 test/generate_sample_resume.py');
    process.exit(1);
  }

  console.log(`Reading: ${pdfPath}`);
  const buffer = fs.readFileSync(pdfPath);

  section('STEP 1 — PDF TEXT EXTRACTION  (pdfService.extractText)');
  const t0 = Date.now();
  const { text, pageCount } = await pdfService.extractText(buffer);
  console.log(`Pages: ${pageCount}  |  Extracted characters: ${text.length}  |  Time: ${Date.now() - t0}ms`);
  console.log('--- first 300 characters ---');
  console.log(text.slice(0, 300) + '...');

  section('STEP 2 — SECTION PARSING  (resumeParserService.parse)');
  const t1 = Date.now();
  const parsedResume = resumeParserService.parse(text);
  console.log(`Time: ${Date.now() - t1}ms`);
  console.log(JSON.stringify(parsedResume, null, 2));

  section('STEP 3 — LLM RESUME ANALYSIS  (ollamaService.analyseResume)');
  console.log('(Falls back to a heuristic summary automatically if Ollama is not running.)');
  const t2 = Date.now();
  const analysis = await ollamaService.analyseResume(parsedResume);
  console.log(`Time: ${Date.now() - t2}ms  |  Source: ${analysis.source}`);
  console.log(JSON.stringify(analysis, null, 2));

  section('STEP 4 — RESUME CONTEXT  (contextBuilder.build)  — handed to the Interview module');
  const resumeContext = contextBuilder.build(parsedResume, analysis, {
    interviewType: 'Technical',
    targetRole: 'Software Engineer Intern',
  });
  console.log(JSON.stringify(resumeContext, null, 2));

  section('SUMMARY');
  console.log(`Skills detected:       ${parsedResume.skills.length}`);
  console.log(`Projects detected:     ${parsedResume.projects.length}`);
  console.log(`Experience entries:    ${parsedResume.experience.length}`);
  console.log(`Education entries:     ${parsedResume.education.length}`);
  console.log(`Sections found:        ${parsedResume.meta.sectionsDetected.join(', ')}`);
  if (parsedResume.meta.warnings.length) {
    console.log(`Warnings:              ${parsedResume.meta.warnings.join(' | ')}`);
  }
  console.log(`Analysis source:       ${analysis.source}`);
  console.log('\nDone. This is exactly the object that Module 1/3 (Interview) would');
  console.log('receive from GET /api/resume/:id/context in the running server.\n');
}

main().catch((err) => {
  if (err instanceof pdfService.UnreadableResumeError) {
    console.error(`\nResume could not be processed: ${err.message}`);
    process.exit(1);
  }
  console.error('\nUnexpected error:', err);
  process.exit(1);
});
