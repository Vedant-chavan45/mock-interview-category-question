/** Shared intake checks used by both instant upload preflight and final submission.
 * No AI or database side effects occur before this completes successfully. */
const pdfService = require('./pdfService');
const resumeParserService = require('./resumeParserService');
const resumeValidityService = require('./resumeValidityService');

async function inspectUploadedResume(file) {
  pdfService.validateFile(file);
  const { text, pageCount } = await pdfService.extractText(file.buffer);
  const parsedResume = resumeParserService.parse(text);
  resumeValidityService.validateResume(text, parsedResume);
  return { parsedResume, pageCount };
}

module.exports = { inspectUploadedResume };
