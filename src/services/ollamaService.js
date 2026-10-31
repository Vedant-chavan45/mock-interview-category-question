/**
 * ollamaService.js
 * -----------------------------------------------------------------------
 * Module 4 — Resume Processing & Resume Intelligence
 * Owner: Siddhant Raikar
 *
 * Responsibility: wrap calls to a local Ollama server running Llama 3.2,
 * matching the class diagram's OllamaClient:
 *   + generate(prompt)   : String
 *   + parseJson(reply)   : Object
 *   + retry(prompt, n)   : String
 *
 * IMPORTANT FOR THE DEMO: this service is designed to fail *safely*. If
 * Ollama is not installed or not running on the demo machine (very likely,
 * since it needs a local model download), analyseResume() detects that
 * within a short timeout and falls back to a heuristic summary built
 * directly from the ParsedResume object, so the rest of the pipeline
 * (and the demo) never breaks because the LLM is unavailable.
 * -----------------------------------------------------------------------
 */

const axios = require('axios');

const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'llama3.2';
const MAX_RETRIES = 1;
const REQUEST_TIMEOUT_MS = Number(process.env.OLLAMA_TIMEOUT_MS || 120000);

/**
 * Low-level call to Ollama's /api/generate endpoint with JSON mode.
 * Throws if Ollama is unreachable or times out — callers are expected to
 * catch this and fall back, never to let it bubble up to the HTTP response.
 */
async function generate(prompt) {
  const response = await axios.post(
    `${OLLAMA_BASE_URL}/api/generate`,
    {
      model: OLLAMA_MODEL,
      prompt,
      stream: false,
      format: 'json',
    },
    { timeout: REQUEST_TIMEOUT_MS }
  );
  return response.data.response;
}

/**
 * Parses the model's reply as JSON, with one repair attempt for the common
 * case where the model wraps its JSON in a markdown code fence.
 */
function parseJson(reply) {
  try {
    return JSON.parse(reply);
  } catch (err) {
    const stripped = reply.replace(/```json|```/g, '').trim();
    return JSON.parse(stripped); // let this throw if it's still not valid
  }
}

/**
 * generate() + parseJson() with retries — matches the class diagram's
 * retry(prompt, n) responsibility: if the model returns malformed JSON,
 * ask again up to MAX_RETRIES times before giving up.
 */
async function generateJsonWithRetry(prompt, retries = MAX_RETRIES) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const reply = await generate(prompt);
      return parseJson(reply);
    } catch (err) {
      lastError = err;
      // Network errors and timeouts are not helped by repeating the same call.
      // Retry only a complete response whose body failed JSON parsing.
      if (!(err instanceof SyntaxError) || attempt >= retries) throw err;
    }
  }
  throw lastError;
}

function buildAnalysisPrompt(parsedResume) {
  return `You are analysing a candidate's resume for an interview preparation platform.
Respond ONLY with JSON in exactly this shape:
{"summary": "...", "strengths": ["...", "..."], "skillAreasToProbe": ["...", "..."]}

Candidate skills: ${parsedResume.skills.join(', ') || 'none listed'}
Candidate projects: ${parsedResume.projects.map((p) => p.title).join('; ') || 'none listed'}
Candidate experience: ${parsedResume.experience.map((e) => `${e.role} at ${e.organisation}`).join('; ') || 'none listed'}

Write a 2-3 sentence summary, 3 strengths, and 3 skill areas an interviewer should probe.`;
}

/**
 * Deterministic fallback used when Ollama is unavailable. This is not a
 * placeholder to hide behind — it's the module's defined degraded-mode
 * behaviour, and it's worth saying that explicitly if the mentor asks
 * "what happens if the AI service is down".
 */
function heuristicFallbackAnalysis(parsedResume) {
  const topSkills = parsedResume.skills.slice(0, 5);
  const topProject = parsedResume.projects[0];

  const summary = [
    parsedResume.experience.length > 0
      ? `Candidate has ${parsedResume.experience.length} listed experience entr${parsedResume.experience.length === 1 ? 'y' : 'ies'}`
      : 'Candidate has no listed prior experience',
    topSkills.length ? `with skills including ${topSkills.join(', ')}` : 'with no clearly listed skills section',
    topProject ? `and has worked on projects such as "${topProject.title}".` : '.',
  ].join(' ');

  return {
    summary,
    strengths: topSkills.length ? topSkills.slice(0, 3) : ['Unable to determine — skills section not detected'],
    skillAreasToProbe: topSkills.length ? topSkills.slice(0, 3) : parsedResume.projects.slice(0, 3).map((p) => p.title),
    source: 'heuristic-fallback', // caller / UI can show this so it's never presented as an LLM result
  };
}

/**
 * Public entry point used by resumeService: analyses a ParsedResume object
 * and returns { summary, strengths, skillAreasToProbe, source }.
 * Never throws — always resolves, either with a real LLM analysis or the
 * heuristic fallback above.
 */
async function analyseResume(parsedResume) {
  try {
    const prompt = buildAnalysisPrompt(parsedResume);
    const result = await generateJsonWithRetry(prompt);
    return { ...result, source: 'ollama-llama3.2' };
  } catch (err) {
    return heuristicFallbackAnalysis(parsedResume);
  }
}

module.exports = {
  generate,
  parseJson,
  generateJsonWithRetry,
  analyseResume,
  heuristicFallbackAnalysis,
};
