/**
 * pdfService.js
 * -----------------------------------------------------------------------
 * Module 4 — Resume Processing & Resume Intelligence
 * Owner: Siddhant Raikar
 *
 * Responsibility: turn an uploaded PDF (as a buffer) into clean, usable text.
 * This is intentionally the *only* file in the module that talks to the PDF
 * parsing library, so that the rest of the module never has to know how PDF
 * text extraction actually works — it only ever sees a string.
 * -----------------------------------------------------------------------
 */

const pdfParse = require('pdf-parse');
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const MAX_FILE_SIZE_BYTES = 5 * 1024 * 1024; // 5 MB, matches FR2/NFR limits
const MIN_USABLE_TEXT_LENGTH = 50; // below this, we treat the PDF as "unreadable"

class UnreadableResumeError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UnreadableResumeError';
  }
}

/**
 * Validates that the uploaded file looks like a PDF and is within size limits.
 * This mirrors the "Validate File" use case on the Module 4 use case diagram.
 */
function validateFile(file) {
  if (!file) {
    throw new UnreadableResumeError('No file was uploaded.');
  }
  if (file.mimetype !== 'application/pdf') {
    throw new UnreadableResumeError(
      `Invalid file type: ${file.mimetype}. Only application/pdf is accepted.`
    );
  }
  if (file.size > MAX_FILE_SIZE_BYTES) {
    throw new UnreadableResumeError(
      `File too large: ${(file.size / 1024 / 1024).toFixed(2)}MB. Limit is ${MAX_FILE_SIZE_BYTES / 1024 / 1024}MB.`
    );
  }
}

/**
 * Fallback extraction using poppler-utils' `pdftotext` CLI. This exists
 * because pdf-parse bundles an older build of pdf.js that occasionally
 * rejects a structurally valid PDF (different producers write their
 * cross-reference tables slightly differently — this is a real,
 * reproducible case, not a hypothetical). Rather than let a perfectly
 * fine resume get rejected as "unreadable" because of a library quirk,
 * a second extraction path is tried before giving up.
 *
 * Returns null (never throws) if `pdftotext` isn't installed or also
 * fails — callers treat that the same as "primary extraction failed".
 */
function extractTextWithPdftotext(fileBuffer) {
  return new Promise((resolve) => {
    const tmpFile = path.join(os.tmpdir(), `resume-${crypto.randomUUID()}.pdf`);
    fs.writeFileSync(tmpFile, fileBuffer);

    execFile('pdftotext', ['-layout', tmpFile, '-'], { maxBuffer: 10 * 1024 * 1024 }, (err, stdout) => {
      fs.unlink(tmpFile, () => {}); // best-effort cleanup, don't block on it
      if (err || !stdout) {
        resolve(null);
        return;
      }
      resolve(stdout);
    });
  });
}

/**
 * Extracts raw text from a PDF buffer, then does light normalisation
 * (collapsing repeated whitespace, fixing common ligature/bullet artefacts
 * that PDF extraction sometimes leaves behind).
 *
 * Tries pdf-parse first (pure JS, no external binary — the simplest path,
 * and what the class/LLD diagrams document). If that throws, falls back to
 * the poppler `pdftotext` CLI before concluding the PDF is genuinely
 * unreadable. Only after both fail do we raise UnreadableResumeError —
 * that's the "Text extracted?" decision point on the activity diagram,
 * and the most common genuine failure mode is a resume that's a scanned
 * image with no text layer at all, which neither path can recover from.
 */
async function extractText(fileBuffer) {
  let rawText = null;
  let pageCount = null;

  try {
    const data = await pdfParse(fileBuffer);
    rawText = data.text;
    pageCount = data.numpages;
  } catch (primaryErr) {
    const fallbackText = await extractTextWithPdftotext(fileBuffer);
    if (fallbackText) {
      rawText = fallbackText;
      pageCount = (fallbackText.match(/\f/g) || []).length + 1; // form-feed = page break
    }
  }

  const cleaned = cleanText(rawText);

  if (!cleaned || cleaned.length < MIN_USABLE_TEXT_LENGTH) {
    throw new UnreadableResumeError(
      'No usable text could be extracted from this PDF. It may be a scanned image ' +
      'rather than a text-based document; OCR is not part of the current MVP scope.'
    );
  }

  return {
    text: cleaned,
    pageCount: pageCount || 1,
    rawLength: (rawText || '').length,
  };
}

/**
 * Normalises whitespace and common PDF extraction artefacts so that the
 * downstream section parser has predictable input to work with.
 */
function cleanText(rawText) {
  if (!rawText) return '';
  return rawText
    .replace(/\r\n/g, '\n')
    .replace(/•|●|▪|‣|/g, '\n- ') // common bullet glyphs -> "- "
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .trim();
}

module.exports = {
  validateFile,
  extractText,
  cleanText,
  UnreadableResumeError,
  MAX_FILE_SIZE_BYTES,
};
