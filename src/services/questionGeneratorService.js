/**
 * questionGeneratorService.js
 * -----------------------------------------------------------------------
 * Module 4 — Resume Processing & Resume Intelligence
 * Owner: Siddhant Raikar
 *
 * IMPORTANT — architecture note: on the team's module dependency slide,
 * "personalised question generation" belongs to the Interview module
 * (Modules 1/3), not Module 4. Module 4's real job ends at producing the
 * ResumeContext object (see contextBuilder.js) and handing it off.
 *
 * This service exists so the DEMO can show the whole flow end-to-end —
 * "here's what a real interview question generated from this exact resume
 * looks like" — without overclaiming Module 4's actual scope. It consumes
 * a ResumeContext exactly the way the Interview module would, and nothing
 * about it requires touching resumeParserService/pdfService/ollamaService
 * again. Mention this boundary explicitly if a mentor asks who "owns"
 * question generation.
 *
 * The legacy mixed-question/demo function retains an explicitly labelled
 * deterministic fallback. The six category endpoints are AI-only: they use
 * evidence-based blueprints and validation, and return an error rather than
 * silently presenting rule-based questions as a successful AI generation.
 * -----------------------------------------------------------------------
 */

const axios = require('axios');
const { createHash } = require('node:crypto');
const { StringDecoder } = require('node:string_decoder');
const interviewPlannerService = require('./interviewPlannerService');
const { validateGeneratedQuestions, validateGeneratedCategoryQuestions } = require('./questionValidatorService');
const { QUESTION_COUNT_PER_CATEGORY, getQuestionCategory } = require('./questionCategories');
const { buildCategoryBlueprint, categoryEvidencePreflight, contextData, compact } = require('./categoryBlueprintService');

const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'llama3.2';
const OLLAMA_KEEP_ALIVE = process.env.OLLAMA_KEEP_ALIVE || '10m';
const TOTAL_TIMEOUT_MS = positiveInteger(process.env.QUESTION_GENERATION_TIMEOUT_MS, 90000);
const REQUEST_TIMEOUT_MS = positiveInteger(process.env.OLLAMA_TIMEOUT_MS, 90000);
// Six short questions plus JSON structure usually fit comfortably in this budget.
const NUM_PREDICT = positiveInteger(process.env.QUESTION_GENERATION_NUM_PREDICT, 192);
const NUM_CTX = positiveInteger(process.env.QUESTION_GENERATION_NUM_CTX, 4096);
const RETRY_MIN_REMAINING_MS = 15000;
const CATEGORY_PROMPT_VERSION = 'real-interview-conversational-v15-category-topic-not-wording-gated';
const categoryCache = new Map();
let categoryQueue = Promise.resolve();
// Keep the constrained grammar small. Length limits are enforced in our validator,
// not in the model's decoding grammar, which can be expensive on small local models.
// Type labels are assigned by the application from the required slot order.
const QUESTION_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    questions: { type: 'array', minItems: 6, maxItems: 6, items: { type: 'string' } },
  },
  required: ['questions'], additionalProperties: false,
};
const CATEGORY_QUESTION_RESPONSE_SCHEMA = {
  type: 'object', properties: { questions: { type: 'array', minItems: QUESTION_COUNT_PER_CATEGORY, maxItems: QUESTION_COUNT_PER_CATEGORY,
    items: { type: 'string', minLength: 1, maxLength: 240 },
  } }, required: ['questions'], additionalProperties: false,
};

function categoryResponseSchema(blueprint, expectedSlots = blueprint.slots) {
  return {
    type: 'object', properties: { questions: { type: 'array', minItems: expectedSlots.length, maxItems: expectedSlots.length,
      items: { type: 'string', minLength: 1, maxLength: 240 },
    } }, required: ['questions'], additionalProperties: false,
  };
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

async function generate(prompt, timeout, onFirstChunk, responseSchema = QUESTION_RESPONSE_SCHEMA, externalSignal) {
  if (externalSignal?.aborted) throw Object.assign(new Error('Ollama request was cancelled.'), { code: 'ERR_CANCELED' });
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeout);
  const abortFromCaller = () => controller.abort();
  externalSignal?.addEventListener('abort', abortFromCaller, { once: true });
  let response;
  let buffer = '';
  let reply = '';
  let done = false;
  let doneReason;
  let evalCount;
  let promptEvalCount;
  let totalDuration;
  let loadDuration;
  let promptEvalDuration;
  let evalDuration;
  let firstChunk = true;
  const decoder = new StringDecoder('utf8');

  const collectRecord = (record) => {
    if (typeof record.response === 'string') reply += record.response;
    if (record.done === true) {
      done = true;
      if (typeof record.done_reason === 'string') doneReason = record.done_reason;
      if (Number.isSafeInteger(record.eval_count)) evalCount = record.eval_count;
      if (Number.isSafeInteger(record.prompt_eval_count)) promptEvalCount = record.prompt_eval_count;
      for (const [key, value] of [['total_duration', record.total_duration], ['load_duration', record.load_duration],
        ['prompt_eval_duration', record.prompt_eval_duration], ['eval_duration', record.eval_duration]]) {
        if (Number.isSafeInteger(value) && value >= 0) {
          if (key === 'total_duration') totalDuration = value;
          else if (key === 'load_duration') loadDuration = value;
          else if (key === 'prompt_eval_duration') promptEvalDuration = value;
          else evalDuration = value;
        }
      }
    }
  };

  try {
    response = await axios.post(
      `${OLLAMA_BASE_URL}/api/generate`,
      {
        model: OLLAMA_MODEL,
        prompt,
        stream: true,
        format: responseSchema,
        keep_alive: OLLAMA_KEEP_ALIVE,
        options: { num_predict: NUM_PREDICT, num_ctx: NUM_CTX, temperature: 0.2 },
      },
      { timeout, signal: controller.signal, responseType: 'stream' }
    );

    if (response.data && typeof response.data[Symbol.asyncIterator] === 'function') {
      for await (const chunk of response.data) {
        if (firstChunk) {
          firstChunk = false;
          onFirstChunk?.();
        }
        buffer += decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8'));
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop();
        for (const line of lines) {
          if (!line.trim()) continue;
          collectRecord(JSON.parse(line));
        }
        if (done) break;
      }
      buffer += decoder.end();
      if (buffer.trim()) collectRecord(JSON.parse(buffer));
    } else if (typeof response.data?.response === 'string') {
      // Tolerate buffered adapters in unit tests and compatible proxies.
      reply = response.data.response;
      done = response.data.done !== false;
      doneReason = response.data.done_reason;
      evalCount = response.data.eval_count;
      promptEvalCount = response.data.prompt_eval_count;
      totalDuration = response.data.total_duration;
      loadDuration = response.data.load_duration;
      promptEvalDuration = response.data.prompt_eval_duration;
      evalDuration = response.data.eval_duration;
    }

    return { reply, status: response.status, done, doneReason, evalCount, promptEvalCount,
      totalDuration, loadDuration, promptEvalDuration, evalDuration };
  } catch (err) {
    if (timedOut) {
      const timeoutError = new Error('Ollama request timed out.');
      timeoutError.code = 'ECONNABORTED';
      throw timeoutError;
    }
    if (err instanceof SyntaxError) {
      const responseError = new Error('Ollama returned an invalid stream record.');
      responseError.code = 'OLLAMA_INVALID_RESPONSE';
      responseError.status = response?.status;
      throw responseError;
    }
    throw err;
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener('abort', abortFromCaller);
  }
}

function ollamaMetrics(response, requestMs, validationMs = 0, repairCount = 0, repairMs = 0) {
  const milliseconds = (value) => Number.isSafeInteger(value) && value >= 0 ? Math.round(value / 1e6) : undefined;
  return {
    requestMs,
    modelLoadMs: milliseconds(response.loadDuration),
    promptEvalMs: milliseconds(response.promptEvalDuration),
    outputGenerationMs: milliseconds(response.evalDuration),
    modelTotalMs: milliseconds(response.totalDuration),
    promptTokens: Number.isSafeInteger(response.promptEvalCount) ? response.promptEvalCount : undefined,
    outputTokens: Number.isSafeInteger(response.evalCount) ? response.evalCount : undefined,
    validationMs,
    repairCount,
    repairMs,
  };
}

async function requestCategoryJson(prompt, responseSchema, categoryId, signal, deadline = Date.now() + TOTAL_TIMEOUT_MS) {
  const requestStartedAt = Date.now();
  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) throw Object.assign(new Error('Question generation deadline exceeded.'), { code: 'QUESTION_GENERATION_TIMEOUT' });
  const timeoutMs = Math.min(REQUEST_TIMEOUT_MS, remainingMs);
  const response = await generate(prompt, timeoutMs, () => debugGeneration({ stage: 'first-chunk', categoryId,
    durationMs: Date.now() - requestStartedAt, category: 'streaming' }), responseSchema, signal);
  const requestMs = Date.now() - requestStartedAt;
  if (!response.done) throw Object.assign(new Error('Ollama stream did not complete.'), { code: 'OLLAMA_INCOMPLETE_STREAM' });
  if (!response.reply?.trim()) throw Object.assign(new Error('Ollama completed with an empty response.'), { code: 'OLLAMA_EMPTY_RESPONSE' });
  let parsed;
  try { parsed = parseJson(response.reply); }
  catch (error) {
    debugGeneration({ stage: 'json-parse-failed', role: 'resume candidate', categoryId,
      durationMs: requestMs, httpStatus: response.status, category: 'json-parse-error' });
    throw error;
  }
  debugGeneration({ stage: 'request-complete', role: 'resume candidate', categoryId, durationMs: requestMs,
    httpStatus: response.status, completedStream: true, jsonParsed: true,
    questionCount: Array.isArray(parsed?.questions) ? parsed.questions.length : undefined, category: 'json-ok' });
  return { parsed, response, requestMs };
}

function parseJson(reply) {
  try {
    return JSON.parse(reply);
  } catch (err) {
    const stripped = reply.replace(/```json|```/g, '').trim();
    return JSON.parse(stripped);
  }
}

function expectedQuestionTypes(resumeContext) {
  const c = candidateData(resumeContext);
  const hasProjects = c.projects.length > 0;
  const hasExperience = c.experience.length > 0 || !!c.experienceSummary;
  const counts = {
    technical: 6 - (hasProjects ? 2 : 0) - (hasExperience ? 1 : 0) - 1,
    project: hasProjects ? 2 : 0,
    experience: hasExperience ? 1 : 0,
    behavioral: 1,
  };
  return Object.entries(counts).flatMap(([type, count]) => Array(count).fill(type));
}

async function generateJsonWithRetry(prompt, role, validate, responseSchema = QUESTION_RESPONSE_SCHEMA, categoryId = 'legacy-mixed', slotIds = []) {
  const startedAt = Date.now();
  const deadline = startedAt + TOTAL_TIMEOUT_MS;
  let attempt = 0;
  while (Date.now() < deadline) {
    attempt += 1;
    const remaining = deadline - Date.now();
    try {
      const timeoutMs = Math.max(1, Math.min(REQUEST_TIMEOUT_MS, remaining));
      const requestStartedAt = Date.now();
      debugGeneration({ stage: 'request-start', role, startedAt, attempt, timeoutMs, categoryId,
        category: 'pending', source: 'pending' });
      let response;
      try {
        response = await generate(prompt, timeoutMs, () => debugGeneration({ stage: 'first-chunk', role, startedAt, categoryId,
          attempt, durationMs: Date.now() - requestStartedAt, timeoutMs, category: 'streaming' }), responseSchema);
        debugGeneration({ stage: 'request-complete', role, startedAt, attempt, categoryId,
          durationMs: Date.now() - requestStartedAt, timeoutMs, status: response.status,
          completedStream: response.done, category: 'ok' });
      } catch (err) {
        debugGeneration({ stage: 'request-failed', role, startedAt, attempt, categoryId,
          durationMs: Date.now() - requestStartedAt, timeoutMs, completedStream: false, jsonParsed: false, questionCount: 0,
          ...safeRequestDetails(err),
          category: questionGenerationErrorCategory(err) });
        throw err;
      }
      if (!response.done) {
        const error = new Error('Ollama stream did not complete.');
        error.code = 'OLLAMA_INCOMPLETE_STREAM';
        error.status = response.status;
        error.completedStream = false;
        throw error;
      }
      if (typeof response.reply !== 'string' || !response.reply.trim()) {
        const error = new Error('Ollama completed with an empty response.');
        error.code = 'OLLAMA_EMPTY_RESPONSE';
        error.status = response.status;
        throw error;
      }
      let parsed;
      try {
        parsed = parseJson(response.reply);
      } catch (err) {
        debugGeneration({ stage: 'json-parse-failed', role, startedAt, attempt,
        durationMs: Date.now() - requestStartedAt, timeoutMs, httpStatus: response.status,
        categoryId, completedStream: response.done, jsonParsed: false, questionCount: 0, category: 'json-parse-error' });
        throw err;
      }
      const parsedQuestionCount = Array.isArray(parsed?.questions) ? parsed.questions.length : Array.isArray(parsed) ? parsed.length : undefined;
      debugGeneration({ stage: 'json-parse-complete', role, startedAt, attempt, categoryId,
        durationMs: Date.now() - requestStartedAt, timeoutMs, httpStatus: response.status,
        jsonParsed: true, questionCount: parsedQuestionCount, category: 'json-ok' });
      try {
        const validated = validate(parsed);
        debugGeneration({ stage: 'validation-complete', role, startedAt, attempt, categoryId, questionCount: validated.length,
          durationMs: Date.now() - requestStartedAt, timeoutMs, httpStatus: response.status,
          completedStream: true, jsonParsed: true, validationResult: 'passed', category: 'valid', source: `ollama-${OLLAMA_MODEL}` });
        return validated;
      } catch (err) {
        debugGeneration({ stage: 'validation-failed', role, startedAt, attempt, categoryId,
          durationMs: Date.now() - requestStartedAt, timeoutMs, httpStatus: response.status,
          completedStream: true, jsonParsed: true, questionCount: err.questionCount ?? parsedQuestionCount,
          questionIndex: err.questionIndex, slotId: Number.isSafeInteger(err.questionIndex) ? slotIds[err.questionIndex] : undefined,
          validationResult: 'failed', category: questionGenerationDiagnostic(err) });
        throw err;
      }
    } catch (err) {
      const category = questionGenerationErrorCategory(err);
      // Retry only a complete response that is malformed JSON. Request failures,
      // timeout errors, and semantic validation failures go directly to fallback.
      const retryable = category === 'json-parse-error';
      const remainingMs = deadline - Date.now();
      if (!retryable || attempt >= 2 || remainingMs < RETRY_MIN_REMAINING_MS) throw err;
    }
  }
  const error = new Error('Question generation deadline exceeded.');
  error.code = 'QUESTION_GENERATION_TIMEOUT';
  throw error;
}

function safeRequestDetails(err) {
  const codes = new Set(['ECONNABORTED', 'ETIMEDOUT', 'ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND',
    'EAI_AGAIN', 'ERR_NETWORK', 'ERR_BAD_REQUEST', 'ERR_BAD_RESPONSE', 'ERR_CANCELED', 'EHOSTUNREACH', 'ENETUNREACH']);
  const details = {};
  if (codes.has(err.code)) details.errorCode = err.code;
  const status = err.response?.status ?? err.status;
  if (Number.isInteger(status) && status >= 100 && status <= 599) details.httpStatus = status;
  return details;
}

function debugGeneration({ stage, role, categoryId = 'legacy-mixed', startedAt, attempt, durationMs, timeoutMs,
  status, httpStatus, errorCode, questionCount, questionIndex, slotId, completedStream, jsonParsed,
  validationResult, source, category, metrics }) {
  if (process.env.DEBUG_QUESTION_GENERATION === '1') {
    const details = [`categoryId=${categoryId}`];
    if (Number.isSafeInteger(durationMs)) details.push(`durationMs=${durationMs}`);
    if (Number.isInteger(status ?? httpStatus)) details.push(`httpStatus=${status ?? httpStatus}`);
    if (typeof completedStream === 'boolean') details.push(`completion=${completedStream ? 'done' : 'incomplete'}`);
    if (stage === 'request-failed') details.push(`completion=${category || 'failed'}`);
    if (Number.isSafeInteger(questionCount)) details.push(`questionCount=${questionCount}`);
    if (category && !['valid', 'ok', 'pending', 'streaming', 'json-ok'].includes(category)) details.push(`validationReason=${category}`);
    if (stage === 'fallback-selected') details.push('fallbackSelected=true');
    if (stage === 'validation-complete') details.push('fallbackSelected=false');
    details.push(`stage=${stage}`);
    if (typeof completedStream === 'boolean') details.push(`completedStream=${completedStream}`);
    if (typeof jsonParsed === 'boolean') details.push(`jsonParsed=${jsonParsed}`);
    if (validationResult) details.push(`validation=${validationResult}`);
    if (Number.isSafeInteger(questionIndex)) details.push(`questionIndex=${questionIndex}`);
    if (typeof slotId === 'string') details.push(`slotId=${slotId}`);
    if (source) details.push(`source=${source}`);
    if (errorCode) details.push(`errorCode=${errorCode}`);
    if (metrics) for (const [key, value] of Object.entries(metrics)) {
      if (typeof value === 'number' && Number.isFinite(value)) details.push(`${key}=${value}`);
    }
    console.error(`[questionGeneratorService] ${details.join(' ')}`);
  }
}

// Normalize only the context consumed here; legacy documents need no migration.
const text = (value) => typeof value === 'string' ? value.trim() : '';
const list = (value) => Array.isArray(value) ? value : [];
const strings = (value) => list(value).map(text).filter(Boolean);
const object = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {};

function candidateData(context) {
  const c = object(context);
  return {
    targetRole: text(c.targetRole) || 'Software Engineer',
    interviewType: text(c.interviewType) || 'Technical',
    candidateSummary: text(c.candidateSummary),
    strengths: strings(c.strengths),
    skillAreasToProbe: strings(c.skillAreasToProbe),
    skills: strings(c.skills),
    projects: list(c.projects).map((value) => {
      const p = object(value);
      return { title: text(p.title), technologies: strings(p.technologies), description: text(p.description) };
    }).filter((p) => p.title || p.description || p.technologies.length),
    experience: list(c.experience).map((value) => {
      const e = object(value);
      return { role: text(e.role), organisation: text(e.organisation), duration: text(e.duration),
        responsibilities: strings(e.responsibilities) };
    }).filter((e) => e.role || e.organisation || e.duration || e.responsibilities.length),
    experienceSummary: text(c.experienceSummary),
    education: list(c.education).map((value) => {
      const e = object(value);
      return [text(e.degree), text(e.institution), text(e.year)].filter(Boolean).join(', ');
    }).filter(Boolean),
  };
}

function buildQuestionPrompt(resumeContext, interviewPlan = interviewPlannerService.buildInterviewPlan(resumeContext)) {
  const c = candidateData(resumeContext);
  const orderedTypes = expectedQuestionTypes(resumeContext);
  const slotRequirements = orderedTypes.map((type, index) => `${index + 1}. ${type}`).join('\n');
  const compactProjects = c.projects.slice(0, 3).map((p) => ({
    title: p.title,
    technologies: p.technologies.slice(0, 4),
    details: p.description.slice(0, 105),
  }));
  const compactExperience = c.experience.slice(0, 2).map((e) => ({
    role: e.role,
    organisation: e.organisation,
    duration: e.duration,
    responsibilities: e.responsibilities.slice(0, 2).map((r) => r.slice(0, 75)),
  }));
  const focus = interviewPlan.focusAreas.slice(0, 5).map((area) => ({ topic: area.topic, priority: area.priority }));

  return `Generate exactly six distinct interview questions for ${c.targetRole} (${c.interviewType}).
Return only this JSON object: {"questions":["question 1?","question 2?","question 3?","question 4?","question 5?","question 6?"]}.
The questions array must contain six strings only. Do not return objects, type labels, evidence anchors, markdown, or other fields. The application assigns question types and evidence anchors from the numbered slots and structured resume.
Required slot types in this exact order:
${slotRequirements}
Every question must be one concise sentence, at most 180 characters, and end with a question mark. Technical slots should test applied reasoning about the highest-priority role topics. Project slots should ask about the candidate's actual listed projects. The experience slot should ask about a real challenge and how a fix was verified. The behavioral slot should address feedback, disagreement, communication, or learning.
Use only concrete resume facts for candidate-specific claims; ask role-relevant questions without claiming candidate experience not shown. Prefer projects relevant to the target role. Do not ask standalone definitions or repeat questions in different words.
PLAN ${JSON.stringify({ domain: interviewPlan.primaryDomain, profile: interviewPlan.roleProfile, focus })}
RESUME ${JSON.stringify({ interviewType: c.interviewType, targetRole: c.targetRole,
    skills: c.skills.slice(0, 12), projects: compactProjects, experience: compactExperience,
    experienceSummary: compactExperience.length ? undefined : c.experienceSummary.slice(0, 120), education: c.education.slice(0, 2) })}`;
}

function categoryResumeEvidence(resumeContext, categoryId) {
  const c = contextData(resumeContext);
  const projects = c.projects.slice(0, 8).map((project) => ({ id: project.id, title: project.title,
    technologies: project.technologies.slice(0, 4), details: compact(project.description, 110) }));
  const experiences = c.experience.slice(0, 6).map((entry) => ({ id: entry.id, role: entry.role,
    organisation: entry.organisation, responsibilities: entry.responsibilities.slice(0, 2).map((item) => compact(item, 85)) }));
  if (categoryId === 'technical_concepts') return {
    skills: c.skillEvidence.slice(0, 10),
    projectTechnologies: projects.map(({ id, title, technologies }) => ({ id, title, technologies })),
  };
  if (categoryId === 'project_deep_dive') return { projects };
  if (categoryId === 'professional_experience') return c.experience.length
    ? { experience: experiences }
    : { documentedPracticalProjects: projects };
  if (categoryId === 'behavioral_collaboration') return {
    experience: experiences,
    projects: projects.map((project) => ({ id: project.id, title: project.title })),
  };
  if (categoryId === 'applied_scenarios') return { targetRole: { id: c.targetRoleEvidenceId, value: c.targetRole }, skills: c.skillEvidence.slice(0, 10), projects: projects.map(({ id, title, technologies }) => ({ id, title, technologies })) };
  return { targetRole: { id: c.targetRoleEvidenceId, value: c.targetRole } };
}

function categoryStyleExample(categoryId, blueprint) {
  const firstSkill = blueprint.slots.find((slot) => slot.evidence.provenance.kind.startsWith('resume_'))?.evidence.anchor;
  const firstProject = blueprint.slots.find((slot) => slot.supportingEvidence?.title)?.supportingEvidence?.title;
  const firstExperience = blueprint.slots.find((slot) => slot.supportingEvidence?.role)?.supportingEvidence?.role;
  const firstSlot = blueprint.slots[0]?.slotId;
  const examples = {
    api_lifecycle: 'A user says the API is not working. What would you check first?',
    data_consistency: 'Two people update the same record. How would you avoid losing a change?',
    authentication_security: 'A user can see a page they should not access. What would you check?',
    performance_scalability: 'The app slows down when more people use it. What would you check first?',
    reliability_concurrency: 'Two updates happen at once and one fails. How would you handle it?',
    architecture_tradeoffs: 'A feature is getting hard to maintain. How would you organize it?',
    client_server_boundaries: 'A button works in the browser but nothing is saved. Where would you look first?',
    data_flow: 'A form shows new data but the saved record is old. How would you trace it?',
    performance_accessibility: 'How would you make a slow page load faster and keep keyboard access easy?',
    reliability_debugging: 'The page returns an error when it calls the server. How would you trace it?',
    memory_ownership: 'A C++ object uses memory after it is released. What would you check first?',
    concurrency_synchronization: 'Two threads change the same value. How would you prevent a conflict?',
    operating_system_resources: 'A program cannot open a file. What would you check first?',
    algorithmic_performance: 'A program’s performance drops as its input grows. How would you find the cause?',
    reliability_failure_modes: 'A program has a failure after running for a while. How would you find the cause?',
    systems_tradeoffs: 'How would you decide between a faster design and one that is easier to maintain?',
    test_strategy: 'A small change is ready. What would you test before release?',
    test_data_edges: 'A form works with normal data but fails with blanks. What else would you test?',
    automation_reliability: 'An automated test fails only sometimes. How would you investigate it?',
    api_contracts: 'An API returns the wrong status for bad input. How would you check it?',
    regression_isolation: 'A bug appears after a change. How would you reproduce it and find the cause?',
    release_quality_tradeoffs: 'What would you test first when time is short before a release?',
    data_quality: 'A training dataset has missing labels. How would you check it before training?',
    model_selection: 'Two models give different results. How would you choose the better one?',
    evaluation: 'A model’s score drops on new data. How would you check its performance?',
    performance_resources: 'A model’s performance drops and predictions take too long. What would you measure first?',
    reproducibility: 'The same experiment gives different results. How would you compare the runs?',
    deployment_tradeoffs: 'How would you deploy a model and check that it keeps working after release?',
    schema_modelling: 'A report needs data from two related tables. How would you model them?',
    query_correctness: 'A report shows duplicate rows. How would you check the query result?',
    transactions_consistency: 'Two users update the same record. How would you avoid losing a change?',
    query_performance: 'A database query becomes slow. What would you check first?',
    data_quality_reliability: 'A data pipeline has bad records and stops halfway. How would you find the cause?',
    storage_tradeoffs: 'What storage option would you choose for a feature that saves a lot of data?',
    component_boundaries: 'A page is hard to change. How would you decide what each component should do?',
    state_data_flow: 'A page shows old data after a save. Where would you look for the problem?',
    accessibility_interaction: 'A user cannot reach a button with the keyboard. What would you check?',
    render_performance: 'How would you check why a page renders slowly?',
    client_security_reliability: 'A form accepts unsafe input. How would you validate it and show a clear error?',
    frontend_tradeoffs: 'A page is becoming hard to maintain. How would you simplify its design?',
    system_boundaries: 'Two parts of an app handle the same task. How would you split their responsibilities?',
      data_correctness: 'An update saves the wrong data. How would you find the cause?',
    security_controls: 'A user can access a page they should not see. What would you check?',
    performance_constraints: 'An application slows down when more people use it. What would you check first?',
    failure_recovery: 'A feature suddenly stops working. How would you find the cause and check the fix?',
    engineering_tradeoffs: 'How would you choose between two ways of building a feature?',
  };
  if (categoryId === 'domain_fundamentals') return examples[firstSlot] || examples.system_boundaries;
  if (categoryId === 'technical_concepts') return firstSkill
    ? `How would you use ${firstSkill} to build a small feature and check that it works?`
    : 'How would you check that a feature works before releasing it?';
  if (categoryId === 'project_deep_dive') return firstProject
    ? `Can you explain how ${firstProject} works from a user's point of view?`
    : "Can you explain how this project works from a user's point of view?";
  if (categoryId === 'professional_experience') return firstExperience
    ? `Tell me about a task you handled as a ${firstExperience}?`
    : firstProject
      ? `What part of ${firstProject} were you personally responsible for?`
      : 'Tell me about a task you handled in your practical project work.';
  if (categoryId === 'applied_scenarios') {
    const appliedExamples = {
      api_latency: 'Suppose the API becomes slow during busy hours. What would you check first?',
      database_performance: 'Suppose a report shows the wrong records. How would you find the cause?',
      training_data_quality: 'Suppose a training dataset has missing labels. What would you check before training?',
      pipeline_data_quality: 'Suppose a data import contains missing values. How would you check the source?',
      flaky_automation: 'Suppose an automated test fails only sometimes. How would you investigate it?',
      client_api_mismatch: 'Suppose a page shows the wrong information after an API call. What would you check?',
      resource_exhaustion: 'Suppose a program runs out of memory. What would you check first?',
      service_performance: 'Suppose the app becomes slow when more people use it. What would you check first?',
    };
    return appliedExamples[firstSlot] || 'Suppose a user reports that a feature is not working. What would you check first?';
  }
  if (categoryId === 'behavioral_collaboration') return 'Tell me about a time you took responsibility for finishing an important task?';
  return 'Can you describe how you would handle this at work?';
}

function buildCategoryQuestionPrompt(resumeContext, categoryId, interviewPlan = interviewPlannerService.buildInterviewPlan(resumeContext), blueprint = buildCategoryBlueprint(resumeContext, categoryId, interviewPlan)) {
  const category = getQuestionCategory(categoryId);
  if (!category) throw Object.assign(new Error('Invalid question category.'), { code: 'invalid-category' });

  const seenProjectTitles = new Set();
  const slotObjectives = blueprint.slots.map((slot) => {
    const title = text(slot.supportingEvidence?.title);
    const firstQuestionForProject = ['project_deep_dive', 'professional_experience'].includes(categoryId) && title && !seenProjectTitles.has(title);
    if (title) seenProjectTitles.add(title);
    return {
      slotId: slot.slotId,
      objective: compact(slot.objective, 110),
      ...(slot.questionExample ? { questionExample: slot.questionExample } : {}),
      evidenceId: slot.evidence.id || undefined,
      evidence: compact(slot.evidence.anchor, 64),
      ...(firstQuestionForProject ? { mentionProjectNameOnce: title } : {}),
      ...(categoryId === 'technical_concepts' && slot.evidence.provenance.kind.startsWith('resume_')
        ? { includeSkillName: slot.evidence.anchor } : {}),
      ...(categoryId === 'professional_experience' && slot.supportingEvidence?.selectedResponsibility
        ? { documentedWork: compact(slot.supportingEvidence.selectedResponsibility, 75) } : {}),
      ...(categoryId === 'professional_experience' && slot.supportingEvidence?.practicalExperience
        ? { workContext: 'documented project work, not a paid job unless the resume explicitly says so' } : {}),
      ...(categoryId === 'professional_experience' && slot.slotId === 'collaboration_coordination' && slot.supportingEvidence?.collaborationDocumented === false
        ? { collaborationContext: 'No team collaboration is documented; ask how the candidate planned or tracked their own work without assuming teammates.' } : {}),
      ...(categoryId === 'behavioral_collaboration' && slot.slotId === 'team_collaboration' && slot.supportingEvidence?.collaborationDocumented === false
        ? { collaborationContext: 'No team collaboration is documented; a hypothetical team situation is acceptable, or ask about explaining work clearly or asking for help or input. Do not claim the candidate actually worked in a team.' } : {}),
    };
  });

  const roleNeedsAdvancedDepth = /\b(senior|lead|staff|principal|architect|manager)\b/i.test(blueprint.role);
  const roleDepth = roleNeedsAdvancedDepth
    ? 'Match the stated seniority, but keep every question practical and easy to answer aloud.'
    : 'Use entry-level to early-career interview depth unless the resume clearly shows a senior role.';

  return `Role ${blueprint.role}; interview type ${blueprint.interviewType}; category ${category.id} (${category.label}).\n` +
    `You are interviewing a real candidate for this role. Write six questions a human interviewer would naturally say aloud.\n` +
    `RESUME EVIDENCE: ${JSON.stringify(categoryResumeEvidence(resumeContext, categoryId))}\n` +
    `QUESTION OBJECTIVES IN ORDER: ${JSON.stringify(slotObjectives)}\n` +
    `STYLE: Use simple, everyday professional English that a real interviewer would say out loud. Aim for 8-16 words; do not force a short question if it makes the meaning unclear. ` +
    `Use each slot's questionExample as a guide, but never force its exact keywords or opening words into the question. The category and six slot objectives define the topic, not the wording; any natural paraphrase that addresses the objective is acceptable. ` +
    `Do not write to satisfy or avoid a wording pattern. Choose the clearest way to ask the question. ` +
    `Ask one clear thing per question that a candidate can answer aloud in about 1-3 minutes. Make it easy to understand on the first read. ` +
    `Prefer everyday verbs such as use, build, check, fix, choose, explain, and tell me about. Avoid textbook definitions, exam wording, abstract theory, unexplained jargon, and formal phrases such as 'provide a comprehensive explanation' or 'in the context of'. ` +
    `Use realistic day-to-day situations from this role. Prefer asking what the candidate would check, change, explain, build, test or decide. Do not make a normal work problem sound like an academic exam. ` +
    `Keep each question focused on its assigned topic, but use whatever natural spoken wording fits. Do not force a particular opening phrase. ` +
    `Do not write to satisfy a keyword checker. A question about an application slowing down at peak usage is a valid performance question even if it never says the word performance. ` +
    `Do not ask the candidate to discuss several unrelated things in one question. Vary the openings. End every item with a question mark, including 'Tell me about' and 'Describe' prompts. ${roleDepth}\n` +
    `TONE EXAMPLE (copy the tone, not the words): ${categoryStyleExample(categoryId, blueprint)}\n` +
    `GROUNDING: Do not invent projects, employers, job titles, tools, achievements, numbers, or past events. ` +
    `Technical Skills questions must name their listed skill naturally. Do not force a technology name into every Applied Scenario; use the role and scenario naturally, and never mention a tool absent from the resume. ` +
    `Project Deep Dive must mention each actual project name once; later questions about that same project can say 'this project'. ` +
    `Professional Experience must ask about the work actually shown. Mention each real role or internship title at most once; later questions can say 'that role'. If only projects are listed, call it project work, never employment. ` +
    `Do not claim the candidate actually worked with teammates unless the resume documents that. A clearly hypothetical teammate or team situation is allowed in Behavioral & Collaboration; never present that hypothetical as a past event. ` +
    `Behavioral & Collaboration questions may ask about a real example or a realistic hypothetical people-focused situation. Keep them about ownership, teamwork, communication, feedback, disagreement, accountability, or prioritization; wording such as 'Tell me about' or 'If you were' is optional. Do not claim a hypothetical event actually happened to the candidate. ` +
    `Applied Scenarios must describe a concrete, believable workplace problem and ask what the candidate would check or do. The scenario may be phrased directly or with words such as 'If', 'Suppose', or 'Imagine'; those phrases are optional. Do not ask about the candidate's past experience in this category or replace a scenario with a generic definition. ` +
    `CATEGORY GUIDANCE: ${category.instruction}\n` +
    `Return only {"questions":["question 1?","question 2?","question 3?","question 4?","question 5?","question 6?"]} as JSON. ` +
    `Return exactly six questions in the objective order. No answers, labels, explanations, or markdown.`;
}

function fallbackCategoryQuestion(slot, categoryId, blueprint) {
  const role = shortenAnchor(blueprint.role, 42);
  const anchor = shortenAnchor(slot.evidence.anchor, 80);
  const title = shortenAnchor(slot.supportingEvidence?.title || '', 72);
    if (categoryId === 'domain_fundamentals') {
    const samples = {
      api_lifecycle: 'A user says the API is not working. What would you check first?',
      data_consistency: 'Two people update the same record. How would you avoid losing a change?',
      authentication_security: 'A user can see a page they should not access. What would you check?',
      performance_scalability: 'The app slows down when more people use it. What would you check first?',
      reliability_concurrency: 'Two updates happen at once and one fails. How would you handle it?',
      architecture_tradeoffs: 'A feature is getting hard to maintain. How would you organize it?',
      client_server_boundaries: 'A button works in the browser but nothing is saved. Where would you look first?',
      data_flow: 'A form shows new data but the saved record is old. How would you trace it?',
      performance_accessibility: 'How would you make a slow page load faster and keep keyboard access easy?',
      reliability_debugging: 'The page returns an error when it calls the server. How would you trace it?',
      memory_ownership: 'A C++ object uses memory after it is released. What would you check first?',
      concurrency_synchronization: 'Two threads change the same value. How would you prevent a conflict?',
      operating_system_resources: 'A program cannot open a file. What would you check first?',
      algorithmic_performance: 'A program’s performance drops as its input grows. How would you find the cause?',
      reliability_failure_modes: 'A program has a failure after running for a while. How would you find the cause?',
      systems_tradeoffs: 'How would you decide between a faster design and one that is easier to maintain?',
      test_strategy: 'A small change is ready. What would you test before release?',
      test_data_edges: 'A form works with normal data but fails with blanks. What else would you test?',
      automation_reliability: 'An automated test fails only sometimes. How would you investigate it?',
      api_contracts: 'An API returns the wrong status for bad input. How would you check it?',
      regression_isolation: 'A bug appears after a change. How would you reproduce it and find the cause?',
      release_quality_tradeoffs: 'What would you test first when time is short before a release?',
      data_quality: 'A training dataset has missing labels. How would you check it before training?',
      model_selection: 'Two models give different results. How would you choose the better one?',
      evaluation: 'A model’s score drops on new data. How would you check its performance?',
      performance_resources: 'A model’s performance drops and predictions take too long. What would you measure first?',
      reproducibility: 'The same experiment gives different results. How would you compare the runs?',
      deployment_tradeoffs: 'How would you deploy a model and check that it keeps working after release?',
      schema_modelling: 'A report needs data from two related tables. How would you model them?',
      query_correctness: 'A report shows duplicate rows. How would you check the query result?',
      transactions_consistency: 'Two users update the same record. How would you avoid losing a change?',
      query_performance: 'A database query becomes slow. What would you check first?',
      data_quality_reliability: 'A data pipeline has bad records and stops halfway. How would you find the cause?',
      storage_tradeoffs: 'What storage option would you choose for a feature that saves a lot of data?',
      component_boundaries: 'A page is hard to change. How would you decide what each component should do?',
      state_data_flow: 'A page shows old data after a save. Where would you look for the problem?',
      accessibility_interaction: 'A user cannot reach a button with the keyboard. What would you check?',
      render_performance: 'How would you check why a page renders slowly?',
      client_security_reliability: 'A form accepts unsafe input. How would you validate it and show a clear error?',
      frontend_tradeoffs: 'A page is becoming hard to maintain. How would you simplify its design?',
      system_boundaries: 'Two parts of an app handle the same task. How would you split their responsibilities?',
      data_correctness: 'An update saves the wrong data. How would you find the cause?',
      security_controls: 'A user can access a page they should not see. What would you check?',
      performance_constraints: 'An application slows down when more people use it. What would you check first?',
      failure_recovery: 'A feature suddenly stops working. How would you find the cause and check the fix?',
      engineering_tradeoffs: 'How would you choose between two ways of building a feature?',
    };
    return samples[slot.slotId] || `How would you handle a common problem in a ${role} role?`;
  }
  if (categoryId === 'technical_concepts') {
    if (slot.evidence.provenance.kind === 'missing_resume_skill') {
      return [
        `Which technical skill you know would you use to implement a ${role} feature, and how would you test its behavior?`,
        `How would you connect a technology you know to another part of a ${role} application?`,
        `If a technology you know fails, how would you trace the error and isolate its cause?`,
        `How would you measure whether a technology you know is slowing down a ${role} task?`,
        `How would you check security and correctness when using a technology you know?`,
        `What trade-off would guide your choice among technologies you have actually used?`,
      ][slot.index];
    }
    return [
      `How would you use ${anchor} to build a small feature?`,
      `How does ${anchor} connect to the rest of the application?`,
      `If a feature using ${anchor} stops working, how would you find the cause?`,
      `What would you check if a feature using ${anchor} became slow?`,
      `How would you keep data safe when using ${anchor}?`,
      `When would you choose ${anchor} instead of another option?`,
    ][slot.index];
  }
  if (categoryId === 'project_deep_dive') {
    const mentionedEarlier = title && blueprint.slots.slice(0, slot.index)
      .some((previous) => previous.supportingEvidence?.title === title);
    const projectRef = title && !mentionedEarlier ? title : 'this project';
    return [
      `What problem was ${projectRef} built to solve?`,
      `Which part of ${projectRef} did you handle yourself?`,
      `Can you explain how data moves through ${projectRef}?`,
      `Why did you choose this approach for ${projectRef}?`,
      `How did you test ${projectRef}?`,
      `What would you improve first if you worked on ${projectRef} again?`,
    ][slot.index];
  }
  if (categoryId === 'professional_experience') {
    const documentedRole = slot.supportingEvidence?.role || '';
    const organisation = slot.supportingEvidence?.organisation || '';
    const practicalTitle = slot.supportingEvidence?.title || '';
    if (practicalTitle) {
      const mentionedEarlier = blueprint.slots.slice(0, slot.index)
        .some((previous) => previous.supportingEvidence?.title === practicalTitle);
      const projectRef = mentionedEarlier ? 'this project' : practicalTitle;
      return [
        `What part of ${projectRef} were you responsible for?`,
        `Can you describe a technical contribution you made while working on ${projectRef}?`,
        `Tell me about a challenge you faced while working on ${projectRef}?`,
        slot.supportingEvidence?.collaborationDocumented === false
          ? `How did you plan and track your tasks on ${projectRef}?`
          : `How did you coordinate with others on ${projectRef}?`,
        `How did you check that your work on ${projectRef} was correct?`,
        `What did you learn while working on ${projectRef}?`,
      ][slot.index];
    }
    if (documentedRole || organisation || slot.evidence.provenance.kind === 'resume_experience_summary') {
      const label = shortenAnchor(documentedRole || organisation || anchor, 45);
      const sameRoleEarlier = blueprint.slots.slice(0, slot.index).some((previous) =>
        previous.supportingEvidence?.role === documentedRole && previous.supportingEvidence?.organisation === organisation);
      const scope = sameRoleEarlier ? 'in that role'
        : documentedRole ? `in your ${label} role`
          : organisation ? `at ${label}` : 'during your practical experience';
      return [
        `What responsibility did you handle ${scope}?`,
        `Can you describe a technical contribution you made ${scope}?`,
        `Tell me about a challenge you faced ${scope}?`,
        slot.supportingEvidence?.collaborationDocumented === false
          ? `How did you plan and track your tasks ${scope}?`
          : `How did you coordinate with others ${scope}?`,
        `How did you check that your work ${scope} was correct?`,
        `What did you learn ${scope} that changed how you work?`,
      ][slot.index];
    }
    return [
      'What responsibility have you taken ownership of in practical work?',
      'Can you describe a technical contribution you made in a project?',
      'Tell me about a challenge you faced during practical work?',
      slot.supportingEvidence?.collaborationDocumented === false
        ? 'How did you plan and track your tasks during practical work?'
        : 'How did you coordinate with others during practical work?',
      'How did you check that your work was correct?',
      'What did you learn from practical work that changed how you work?',
    ][slot.index];
  }
  if (categoryId === 'applied_scenarios') {
    const technology = slot.evidence.provenance.kind.startsWith('resume_') ? anchor : '';
    const withTech = (question) => technology ? question(technology) : question('');
    const samples = {
      // Backend Engineering
      api_latency: withTech((tech) => tech ? `Suppose an API using ${tech} becomes slow. What would you check first?` : 'Suppose an API becomes slow during busy hours. What would you check first?'),
      database_performance: withTech((tech) => tech ? `Suppose a ${tech} query returns the wrong records. How would you find the cause?` : 'Suppose a database query returns the wrong records. How would you find the cause?'),
      access_control_failure: withTech((tech) => tech ? `Suppose a protected route using ${tech} lets the wrong user in. What would you check?` : 'Suppose a protected page lets the wrong user in. What would you check?'),
      concurrent_updates: withTech((tech) => tech ? `Suppose two updates through ${tech} change the same record. How would you avoid losing data?` : 'Suppose two users update the same record. How would you avoid losing a change?'),
      integration_failure: withTech((tech) => tech ? `Suppose an integration using ${tech} breaks after a change. How would you find the cause?` : 'Suppose one part of an app breaks after a change. How would you find the cause?'),
      incident_recovery: withTech((tech) => tech ? `Suppose a service using ${tech} stops responding. What would you check first?` : 'Suppose an important service stops responding. What would you check first?'),
      // Full-stack Engineering
      client_api_mismatch: withTech((tech) => tech ? `Suppose a page using ${tech} shows the wrong API data. What would you check?` : 'Suppose a page shows the wrong information after an API call. What would you check?'),
      stale_interface_state: withTech((tech) => tech ? `Suppose a ${tech} page shows old data after a save. What would you check?` : 'Suppose a page shows old data after a save. What would you check?'),
      render_performance: withTech((tech) => tech ? `Suppose a page using ${tech} becomes slow. What would you check first?` : 'Suppose a page becomes slow as more content appears. What would you check first?'),
      release_recovery: withTech((tech) => tech ? `Suppose a release using ${tech} causes errors. How would you check the fix?` : 'Suppose a new release causes errors. How would you check the fix?'),
      // Systems Engineering
      resource_exhaustion: withTech((tech) => tech ? `Suppose a ${tech} program runs out of memory. What would you check first?` : 'Suppose a program runs out of memory. What would you check first?'),
      concurrent_access: withTech((tech) => tech ? `Suppose two ${tech} threads change shared data. How would you prevent a conflict?` : 'Suppose two threads change the same value. How would you prevent a conflict?'),
      operating_system_failure: withTech((tech) => tech ? `Suppose a ${tech} program cannot open a file. What would you check?` : 'Suppose a program cannot open a file. What would you check?'),
      performance_regression: withTech((tech) => tech ? `Suppose a ${tech} program becomes slow after a change. What would you check?` : 'Suppose a program becomes slow after a change. What would you check?'),
      safe_recovery: withTech((tech) => tech ? `Suppose a ${tech} process crashes. How would you recover safely?` : 'Suppose a process crashes. How would you recover safely?'),
      // QA / Test Engineering
      regression_triage: withTech((tech) => tech ? `Suppose a ${tech} test finds a bug after release. How would you reproduce it?` : 'Suppose a release introduces a bug. How would you reproduce it?'),
      flaky_automation: withTech((tech) => tech ? `Suppose a ${tech} test fails only sometimes. How would you find the cause?` : 'Suppose an automated test fails only sometimes. How would you find the cause?'),
      api_contract_failure: withTech((tech) => tech ? `Suppose a ${tech} check finds the wrong API response. What would you inspect?` : 'Suppose an API returns the wrong response. What would you inspect?'),
      edge_case_gap: withTech((tech) => tech ? `Suppose a ${tech} test misses an edge case. What test would you add?` : 'Suppose a test misses an edge case. What test would you add?'),
      environment_integration: withTech((tech) => tech ? `Suppose a ${tech} test passes locally but fails elsewhere. What would you compare?` : 'Suppose a test passes locally but fails elsewhere. What would you compare?'),
      release_verification: withTech((tech) => tech ? `Suppose a ${tech} test fails just before release. What would you check first?` : 'Suppose a fix is ready near release. What would you test first?'),
      // Data Engineering
      pipeline_data_quality: withTech((tech) => tech ? `Suppose a ${tech} data pipeline receives missing values. How would you check the source?` : 'Suppose a data pipeline receives missing values. How would you check the source?'),
      query_results: withTech((tech) => tech ? `Suppose a report using ${tech} shows the wrong total. How would you find the cause?` : 'Suppose a report shows the wrong total. How would you find the cause?'),
      slow_query: withTech((tech) => tech ? `Suppose a ${tech} query becomes slow as data grows. What would you check first?` : 'Suppose a data query becomes slow as records grow. What would you check first?'),
      concurrent_data_updates: withTech((tech) => tech ? `Suppose two jobs update records through ${tech}. How would you keep the data correct?` : 'Suppose two jobs update the same records. How would you keep the data correct?'),
      source_format_change: withTech((tech) => tech ? `Suppose a ${tech} pipeline receives a new file format. How would you handle it?` : 'Suppose a data source changes its format. How would you stop the pipeline breaking?'),
      pipeline_recovery: withTech((tech) => tech ? `Suppose a ${tech} pipeline stops halfway. How would you restart it safely?` : 'Suppose a data pipeline stops halfway. How would you restart it safely?'),
      // AI / ML Engineering
      training_data_quality: withTech((tech) => tech ? `Suppose data prepared with ${tech} has missing labels. What would you check before training?` : 'Suppose a training dataset has missing labels. What would you check before training?'),
      model_generalization: withTech((tech) => tech ? `Suppose a ${tech} model works on training data but fails on new data. What would you check?` : 'Suppose a model works on training data but fails on new data. What would you check?'),
      model_evaluation: withTech((tech) => tech ? `Suppose a ${tech} model score drops. What would you check first?` : 'Suppose a model score drops. What would you check first?'),
      inference_performance: withTech((tech) => tech ? `Suppose predictions from a ${tech} model take too long. What would you check?` : 'Suppose model predictions take too long. What would you check first?'),
      experiment_reproducibility: withTech((tech) => tech ? `Suppose a ${tech} experiment gives different results each time. What would you compare?` : 'Suppose the same model experiment gives different results. What would you compare?'),
      model_deployment_reliability: withTech((tech) => tech ? `Suppose a ${tech} model behaves differently after release. How would you investigate?` : 'Suppose a model behaves differently after release. How would you investigate?'),
      // Generic software engineering
      service_performance: withTech((tech) => tech ? `Suppose an app using ${tech} becomes slow when more people use it. What would you check?` : 'Suppose an app becomes slow when more people use it. What would you check first?'),
      data_correctness: withTech((tech) => tech ? `Suppose an update through ${tech} saves the wrong data. How would you find the cause?` : 'Suppose an update saves the wrong data. How would you find the cause?'),
      concurrent_changes: withTech((tech) => tech ? `Suppose two users update the same record through ${tech}. How would you prevent a lost change?` : 'Suppose two users update the same record. How would you prevent a lost change?'),
    };
    return samples[slot.slotId] || `Suppose a ${role} feature stops working. What would you check first?`;
  }
  if (categoryId === 'behavioral_collaboration') {
    if (slot.slotId === 'team_collaboration' && slot.supportingEvidence?.collaborationDocumented === false) {
      return 'Can you share an example of explaining your work clearly or asking for help?';
    }
    return [
      'Tell me about a time you took responsibility for a task and followed it through?',
      'Tell me about feedback you received that changed how you worked?',
      'Tell me about a disagreement with a teammate and how you handled it?',
      'Can you share an example of helping teammates finish a task?',
      'Tell me about a mistake you made and what you learned from it?',
      'Tell me about a time you had several deadlines and how you chose what to do first?',
    ][slot.index];
  }
  return `How would you approach ${slot.objective.toLowerCase()} for a ${role} role?`;
}

function heuristicFallbackCategoryQuestions(resumeContext, categoryId, interviewPlan = interviewPlannerService.buildInterviewPlan(resumeContext), blueprint = buildCategoryBlueprint(resumeContext, categoryId, interviewPlan)) {
  const category = getQuestionCategory(categoryId);
  if (!category) throw Object.assign(new Error('Invalid question category.'), { code: 'invalid-category' });
  const result = { questions: blueprint.slots.map((slot) => ({
    slotId: slot.slotId,
    question: fallbackCategoryQuestion(slot, categoryId, blueprint),
    evidenceIds: slot.evidence.id ? [slot.evidence.id] : [],
  })) };
  const questions = validateGeneratedCategoryQuestions(result, resumeContext, interviewPlan, category, blueprint);
  return { questions, source: 'heuristic-fallback' };
}

function projectsByPlan(projects, interviewPlan) {
  const areas = list(interviewPlan?.focusAreas);
  const relevance = (project) => {
    const index = areas.findIndex((area) => [project.title, project.description, ...project.technologies]
      .some((claim) => claim && list(area.evidence).includes(claim)));
    return index < 0 ? areas.length : index;
  };
  return projects.slice().sort((left, right) => relevance(left) - relevance(right));
}

function cacheKeyForCategory(resumeContext, categoryId) {
  const candidate = candidateData(resumeContext);
  const evidence = categoryResumeEvidence(resumeContext, categoryId);
  return createHash('sha256').update(JSON.stringify({ version: CATEGORY_PROMPT_VERSION, model: OLLAMA_MODEL,
    categoryId, role: candidate.targetRole, interviewType: candidate.interviewType, evidence })).digest('hex');
}

function enqueueCategoryGeneration(task) {
  const pending = categoryQueue.then(task, task);
  categoryQueue = pending.then(() => undefined, () => undefined);
  return pending;
}

async function generateCategoryQuestions(resumeContext, categoryId, options = {}) {
  const category = getQuestionCategory(categoryId);
  if (!category) throw Object.assign(new Error('Invalid question category.'), { code: 'invalid-category' });
  const queuedAt = Date.now();
  const interviewPlan = interviewPlannerService.buildInterviewPlan(resumeContext);
  const role = candidateData(resumeContext).targetRole;
  const blueprint = buildCategoryBlueprint(resumeContext, categoryId, interviewPlan);
  const key = cacheKeyForCategory(resumeContext, categoryId);
  const signal = options?.signal;
  const force = options?.force === true;

  return enqueueCategoryGeneration(async () => {
    const startedAt = Date.now();
    const queueWaitMs = startedAt - queuedAt;
    if (signal?.aborted) throw Object.assign(new Error('Question generation was cancelled.'), { code: 'ERR_CANCELED' });
    if (!force && categoryCache.has(key)) {
      const cached = categoryCache.get(key);
      categoryCache.delete(key);
      categoryCache.set(key, cached);
      return { ...cached, metrics: { ...cached.metrics, cacheHit: true, queueWaitMs } };
    }

  const evidenceIssue = categoryEvidencePreflight(blueprint);
  if (evidenceIssue) {
    const insufficient = new Error('There is not enough resume evidence for this question category.');
    insufficient.code = 'INSUFFICIENT_RESUME_EVIDENCE';
    insufficient.reason = evidenceIssue.reason;
    insufficient.categoryId = category.id;
    throw insufficient;
  }

  let initial;
  let questions;
  let validationMs = 0;
  let repairCount = 0;
  let repairMs = 0;
  try {
    const deadline = startedAt + TOTAL_TIMEOUT_MS;
    const prompt = buildCategoryQuestionPrompt(resumeContext, categoryId, interviewPlan, blueprint);
    initial = await requestCategoryJson(prompt, categoryResponseSchema(blueprint), category.id, signal, deadline);
    const validationStartedAt = Date.now();
    try {
      questions = validateGeneratedCategoryQuestions(initial.parsed, resumeContext, interviewPlan, category, blueprint);
      validationMs += Date.now() - validationStartedAt;
    } catch (initialValidationError) {
      validationMs += Date.now() - validationStartedAt;
      debugGeneration({ stage: 'validation-failed', role, categoryId: category.id, questionIndex: initialValidationError.questionIndex,
        slotId: Number.isSafeInteger(initialValidationError.questionIndex) ? blueprint.slots[initialValidationError.questionIndex]?.slotId : undefined,
        questionCount: Array.isArray(initial.parsed?.questions) ? initial.parsed.questions.length : undefined, validationResult: 'failed',
        category: questionGenerationDiagnostic(initialValidationError, blueprint.slots) });
      if (!Number.isSafeInteger(initialValidationError.questionIndex) || initialValidationError.questionIndex < 0 ||
          !Array.isArray(initial.parsed?.questions) || initial.parsed.questions.length !== QUESTION_COUNT_PER_CATEGORY) throw initialValidationError;

      // Collect every per-slot issue before repair. A single bad question should not
      // cause the category to fail after repairing only the first of several issues.
      let slotIssues;
      try {
        const detailed = validateGeneratedCategoryQuestions(initial.parsed, resumeContext, interviewPlan, category, blueprint, { collectErrors: true });
        slotIssues = Array.isArray(detailed?.errors) ? detailed.errors : [];
      } catch {
        throw initialValidationError;
      }
      if (!slotIssues.length) slotIssues = [{ questionIndex: initialValidationError.questionIndex, code: initialValidationError.code }];
      const repairItems = slotIssues.map((issue) => {
        const slot = blueprint.slots[issue.questionIndex];
        const invalidQuestion = initial.parsed.questions[issue.questionIndex];
        const requiredPhrase = ['project_deep_dive', 'professional_experience'].includes(category.id)
          ? (slot.supportingEvidence?.title && !initial.parsed.questions.slice(0, issue.questionIndex).some((question) =>
            typeof question === 'string' && question.toLowerCase().includes(slot.supportingEvidence.title.toLowerCase()))
            ? slot.supportingEvidence.title : '')
          : category.id === 'technical_concepts' ? slot.evidence.anchor : '';
        return {
          questionIndex: issue.questionIndex, slot,
          rejectedQuestion: typeof invalidQuestion === 'string' ? invalidQuestion : '',
          reason: issue.code || initialValidationError.code,
          requiredPhrase,
        };
      });
      const repairSlots = repairItems.map((item) => item.slot);
      const repairPayload = repairItems.map((item) => ({
        slotId: item.slot.slotId,
        objective: item.slot.objective,
        evidence: { id: item.slot.evidence.id || undefined, anchor: item.slot.evidence.anchor,
          details: item.slot.supportingEvidence?.selectedResponsibility || item.slot.supportingEvidence?.title || undefined },
        ...(item.slot.questionExample ? { questionExample: item.slot.questionExample } : {}),
        ...(item.requiredPhrase ? { requiredPhrase: item.requiredPhrase } : {}),
        rejectedQuestion: item.rejectedQuestion,
        rejectionReason: item.reason,
      }));
      const repairStartedAt = Date.now();
      const repairPrompt = `Repair ${repairItems.length} invalid interview question slot${repairItems.length === 1 ? '' : 's'} for category ${category.id} (${category.label}) and role ${role}. ` +
        `Return exactly ${repairItems.length} replacement question strings in the same order as REPAIR SLOTS. ` +
        `Each replacement must match its slot objective and questionExample, use simple spoken interview English, and stay close to 8-18 words. ` +
        `Keep each question grounded in its supplied evidence. If requiredPhrase is provided for a slot, include that exact phrase in its replacement. Do not add facts, tools, employers, or past events. ` +
        `For Applied Scenarios, describe a concrete workplace problem; If, Suppose, or Imagine are optional openings. ` +
        `For Professional Experience, focus on documented work. For Behavioral & Collaboration, either a real example or a relevant hypothetical people-focused situation is acceptable. ` +
        `REPAIR SLOTS: ${JSON.stringify(repairPayload)} ` +
        `Return only {\"questions\":[${repairItems.map(() => '\"replacement question?\"').join(',')}]} as JSON.`;
      const repairSchema = categoryResponseSchema(blueprint, repairSlots);
      const repaired = await requestCategoryJson(repairPrompt, repairSchema, category.id, signal, deadline);
      repairMs = Date.now() - repairStartedAt;
      repairCount = 1;
      if (!Array.isArray(repaired.parsed?.questions) || repaired.parsed.questions.length !== repairItems.length ||
          !repaired.parsed.questions.every((question) => typeof question === 'string')) throw initialValidationError;
      const merged = initial.parsed.questions.slice();
      repairItems.forEach((item, index) => { merged[item.questionIndex] = repaired.parsed.questions[index]; });
      const repairedValidationStartedAt = Date.now();
      try { questions = validateGeneratedCategoryQuestions({ questions: merged }, resumeContext, interviewPlan, category, blueprint); }
      catch (repairValidationError) {
        validationMs += Date.now() - repairedValidationStartedAt;
        repairValidationError.repairPerformed = true;
        if (Number.isSafeInteger(repairValidationError.questionIndex)) {
          repairValidationError.rejectedQuestion = merged[repairValidationError.questionIndex];
        }
        repairValidationError.rejectedQuestions = merged;
        throw repairValidationError;
      }
      validationMs += Date.now() - repairedValidationStartedAt;
      initial.response = {
        ...repaired.response,
        totalDuration: (initial.response.totalDuration || 0) + (repaired.response.totalDuration || 0),
        loadDuration: (initial.response.loadDuration || 0) + (repaired.response.loadDuration || 0),
        promptEvalDuration: (initial.response.promptEvalDuration || 0) + (repaired.response.promptEvalDuration || 0),
        evalDuration: (initial.response.evalDuration || 0) + (repaired.response.evalDuration || 0),
        evalCount: (initial.response.evalCount || 0) + (repaired.response.evalCount || 0),
        promptEvalCount: (initial.response.promptEvalCount || 0) + (repaired.response.promptEvalCount || 0),
      };
      initial.requestMs += repaired.requestMs;
    }
    const metrics = { ...ollamaMetrics(initial.response, initial.requestMs, validationMs, repairCount, repairMs),
      cacheHit: false, queueWaitMs, totalDurationMs: Date.now() - startedAt };
    const result = { category: category.id, questions, source: `ollama-${OLLAMA_MODEL}`, model: OLLAMA_MODEL,
      status: 'ready', metrics };
    debugGeneration({ stage: 'validation-complete', role, categoryId: category.id, durationMs: metrics.totalDurationMs,
      questionCount: questions.length, validationResult: 'passed', source: result.source, category: 'valid', metrics });
    categoryCache.set(key, result);
    while (categoryCache.size > 60) categoryCache.delete(categoryCache.keys().next().value);
    return result;
  } catch (err) {
    const diagnosticReason = questionGenerationDiagnostic(err, blueprint.slots);
    if (!err.rejectedQuestion && Number.isSafeInteger(err.questionIndex)) {
      err.rejectedQuestion = initial?.parsed?.questions?.[err.questionIndex];
    }
    // Retain the synthetic fixture's rejected set for the opt-in live diagnostic script.
    // Never write these question strings to normal application logs or API responses.
    if (Array.isArray(initial?.parsed?.questions)) err.rejectedQuestions = initial.parsed.questions.slice();
    err.diagnosticReason = diagnosticReason;
    debugGeneration({ stage: 'generation-failed', role, categoryId: category.id, startedAt, durationMs: Date.now() - startedAt,
      questionCount: Array.isArray(initial?.parsed?.questions) ? initial.parsed.questions.length : undefined,
      questionIndex: err.questionIndex, slotId: Number.isSafeInteger(err.questionIndex) ? blueprint.slots[err.questionIndex]?.slotId : undefined,
      ...safeRequestDetails(err), category: diagnosticReason });
    throw err;
  }
  });
}

/** Deterministic six-question fallback, grounded only in structured evidence. */
function heuristicFallbackQuestions(resumeContext, interviewPlan = interviewPlannerService.buildInterviewPlan(resumeContext)) {
  const c = candidateData(resumeContext);
  const questions = [];
  const add = (question, type, basedOn) => questions.push({ question, type, basedOn });
  const shorten = (value, max = 80) => {
    const cleaned = text(value).replace(/\s+/g, ' ');
    if (cleaned.length <= max) return cleaned;
    const cut = cleaned.slice(0, max - 1);
    const lastSpace = cut.lastIndexOf(' ');
    return `${(lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trim()}…`;
  };
  const projectEvidence = (p) => {
    const title = p.title ? `project "${shorten(p.title, 65)}"` : 'the listed project';
    const stack = p.technologies.length ? ` (${p.technologies.slice(0, 3).map((v) => shorten(v, 22)).join(', ')})` : '';
    return `${title}${stack}`;
  };
  const role = c.targetRole;
  const areas = interviewPlan.focusAreas;
  const supportedAreas = areas.filter((area) => area.evidence.length);
  const technicalAreas = supportedAreas.length ? supportedAreas : areas;
  const projectMatches = (p, area) => [p.title, p.description, ...p.technologies]
    .some((claim) => claim && area.evidence.includes(claim));
  const projectRank = (p) => {
    const index = areas.findIndex((area) => projectMatches(p, area));
    return index < 0 ? areas.length : index;
  };
  c.projects.sort((a, b) => projectRank(a) - projectRank(b));
  const usedSkills = new Set();

  for (let i = 0; i < 2; i += 1) {
    const area = technicalAreas[i % Math.max(technicalAreas.length, 1)];
    const candidates = [
      ...c.projects.flatMap((project) => project.technologies), ...c.skills, ...area.evidence,
    ].filter((claim) => area.evidence.includes(claim) && (!usedSkills.has(claim) ||
      (interviewPlan.roleProfile === 'systems' && area.topic === 'Programming Fundamentals & OOP')));
    const claim = area
      ? interviewPlannerService.rankFocusEvidence(area.topic, candidates, interviewPlan.roleProfile)[0]
      : undefined;
    if (claim) usedSkills.add(claim);
    const project = claim && c.projects.find((p) => p.title === claim || p.description === claim || p.technologies.includes(claim));
    const anchor = project?.title || claim || area?.topic || role;
    const topic = area?.topic || 'technical problem solving';
    add(i === 0
      ? `For a ${shorten(role, 35)} role, how would you approach ${shorten(topic, 40)} using ${shorten(anchor, 45)}? What trade-off would you consider?`
      : `How would you investigate a ${shorten(topic, 42)} problem involving ${shorten(anchor, 45)}, and what evidence would confirm the fix?`,
    'technical', shorten(anchor, 80));
  }

  for (let i = 0; i < 2; i += 1) {
    const project = c.projects[i % (c.projects.length || 1)];
    if (project) {
      const evidence = projectEvidence(project);
      add(i === 0
        ? `In ${evidence}, what was your contribution to an important design decision, and why did you choose that approach?`
        : `How would you test ${evidence} for failure cases and limitations relevant to a ${shorten(role, 35)} role?`,
      'project', shorten(project.title || project.description || project.technologies.join(', '), 80));
    } else {
      const anchor = c.skills[i] || c.education[i] || c.education[0] || role;
      add(i === 0
        ? `How would you apply ${shorten(anchor, 55)} to solve a realistic problem for a ${shorten(role, 35)} role?`
        : `How would you test a solution involving ${shorten(anchor, 55)} and identify its limitations?`,
      'technical', shorten(anchor, 80));
    }
  }

  const experience = c.experience[0];
  const legacy = c.experienceSummary.split(';')[0].trim();
  if (experience || legacy) {
    const label = experience
      ? [experience.role, experience.organisation].filter(Boolean).join(' at ')
      : legacy;
    const responsibility = experience?.responsibilities[0];
    add(`At ${shorten(label || 'your listed experience', 65)}, describe a challenge${responsibility ? ` involving ${shorten(responsibility, 65)}` : ''}; how did you investigate it and verify the fix?`,
      'experience', shorten(experience?.role || experience?.organisation || legacy || 'listed experience', 80));
  } else {
    const anchor = c.projects[0]?.title || c.skills[0] || c.education[0] || role;
    add(`Describe a work or study challenge related to ${shorten(anchor, 55)}. How did you communicate, handle feedback, and decide what to improve?`,
      'technical', shorten(anchor, 80));
  }

  const behavioralAnchor = c.projects[0]?.title || experience?.role || legacy || c.education[0];
  add(`Describe a time you handled feedback or disagreement${behavioralAnchor ? `, drawing on ${shorten(behavioralAnchor, 55)} if relevant` : ''}. How did you communicate and what did you learn?`,
    'behavioral', shorten(behavioralAnchor || 'general', 80));
  return { questions, source: 'heuristic-fallback' };
}

function shortenAnchor(value, maxLength = 80) {
  const clean = text(value).replace(/\s+/g, ' ');
  if (clean.length <= maxLength) return clean;
  const cut = clean.slice(0, maxLength - 1);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > maxLength * 0.6 ? cut.slice(0, lastSpace) : cut).trim()}…`;
}

function structuredAnchors(c) {
  return [...c.skills,
    ...c.projects.flatMap((p) => [p.title, ...p.technologies, p.description]),
    ...c.experience.flatMap((e) => [e.role, e.organisation, e.duration, ...e.responsibilities]),
    ...c.education, c.experienceSummary]
    .map((value) => text(value).replace(/\s+/g, ' ')).filter(Boolean)
    .filter((value, index, all) => all.indexOf(value) === index);
}

function chooseQuestionAnchor(type, slotIndex, types, c, resumeContext, interviewPlan, usedTechnicalAnchors) {
  const claims = structuredAnchors(c);
  if (type === 'behavioral') {
    return shortenAnchor(c.projects[0]?.title || c.experience[0]?.role || c.education[0] || 'general');
  }
  if (type === 'project') {
    const projectOrdinal = types.slice(0, slotIndex + 1).filter((item) => item === 'project').length - 1;
    const projectMatches = (project, area) => [project.title, project.description, ...project.technologies]
      .some((claim) => claim && area.evidence.includes(claim));
    const score = (project) => {
      const index = interviewPlan.focusAreas.findIndex((area) => projectMatches(project, area));
      return index < 0 ? interviewPlan.focusAreas.length : index;
    };
    const projects = c.projects.slice().sort((a, b) => score(a) - score(b));
    const project = projects[projectOrdinal % Math.max(projects.length, 1)];
    return shortenAnchor(project?.title || project?.technologies[0] || project?.description || claims[0] || text(object(resumeContext).targetRole));
  }
  if (type === 'experience') {
    const experience = c.experience[0];
    return shortenAnchor(experience?.role || experience?.organisation || experience?.responsibilities[0] ||
      c.experienceSummary || claims[0] || text(object(resumeContext).targetRole));
  }

  const technicalOrdinal = types.slice(0, slotIndex).filter((item) => item === 'technical').length;
  const supportedAreas = interviewPlan.focusAreas.filter((area) => Array.isArray(area.evidence) && area.evidence.length);
  const area = supportedAreas[technicalOrdinal % Math.max(supportedAreas.length, 1)];
  const candidates = area ? claims.filter((claim) => area.evidence.includes(claim)) : claims;
  const ranked = area
    ? interviewPlannerService.rankFocusEvidence(area.topic, candidates, interviewPlan.roleProfile)
    : candidates;
  const selected = ranked.find((claim) => !usedTechnicalAnchors.has(claim)) || ranked[0] ||
    claims.find((claim) => !usedTechnicalAnchors.has(claim)) || claims[0] || text(object(resumeContext).targetRole);
  if (selected) usedTechnicalAnchors.add(selected);
  return shortenAnchor(selected || '');
}

function applyPlannedMetadata(result, resumeContext, interviewPlan) {
  if (!result || typeof result !== 'object' || Array.isArray(result) ||
      Reflect.ownKeys(result).length !== 1 || !Object.hasOwn(result, 'questions') || !Array.isArray(result.questions)) return result;
  const questionCount = result.questions.length;
  const invalidIndex = result.questions.findIndex((item) => typeof item !== 'string');
  if (invalidIndex >= 0) {
    const error = new Error('Invalid generated questions.');
    error.code = 'invalid-item-shape';
    error.questionCount = questionCount;
    error.questionIndex = invalidIndex;
    throw error;
  }
  const types = expectedQuestionTypes(resumeContext);
  const c = candidateData(resumeContext);
  const usedTechnicalAnchors = new Set();
  return { questions: result.questions.map((question, index) => ({
    question,
    type: types[index],
    basedOn: chooseQuestionAnchor(types[index], index, types, c, resumeContext, interviewPlan, usedTechnicalAnchors),
  })) };
}

function questionGenerationErrorCategory(err) {
  if (err?.code === 'INSUFFICIENT_RESUME_EVIDENCE') return 'insufficient-resume-evidence';
  if (err?.response) return 'ollama-api-error';
  if (err?.code === 'ECONNABORTED' || err?.code === 'ETIMEDOUT' || err?.code === 'QUESTION_GENERATION_TIMEOUT') return 'request-timeout';
  if (err?.code === 'OLLAMA_INCOMPLETE_STREAM') return 'incomplete-stream';
  if (err?.code === 'OLLAMA_EMPTY_RESPONSE') return 'empty-response';
  if (err?.code === 'OLLAMA_INVALID_RESPONSE') return 'ollama-response-error';
  if (axios.isAxiosError(err) || ['ECONNREFUSED', 'ECONNRESET',
    'ENOTFOUND', 'EAI_AGAIN', 'ERR_NETWORK', 'ERR_CANCELED', 'EHOSTUNREACH', 'ENETUNREACH'].includes(err?.code)) {
    return 'ollama-request-error';
  }
  if (err instanceof SyntaxError) return 'json-parse-error';
  if (err instanceof Error && err.message === 'Invalid generated questions.') return 'question-validation-error';
  return 'question-generation-error';
}

function questionGenerationDiagnostic(err, slots = []) {
  const category = questionGenerationErrorCategory(err);
  const parts = [category];
  if (category === 'question-validation-error') {
    const reasons = new Set(['invalid-envelope', 'wrong-question-count', 'invalid-item-shape', 'invalid-type',
      'empty-or-oversized-field', 'duplicate-question', 'invalid-grounding', 'invalid-distribution',
      'invalid-evidence-provenance', 'unsupported-technology', 'unsupported-past-claim',
      'invalid-evidence-reference', 'invalid-slot-id', 'duplicate-slot-id', 'missing-slot-id']);
    if (reasons.has(err.code)) parts.push(`reason=${err.code}`);
    if (Number.isSafeInteger(err.questionIndex) && err.questionIndex >= 0) {
      parts.push(`questionIndex=${err.questionIndex}`);
      if (typeof slots[err.questionIndex]?.slotId === 'string') parts.push(`slotId=${slots[err.questionIndex].slotId}`);
    }
    if (Number.isSafeInteger(err.questionCount) && err.questionCount >= 0) parts.push(`questionCount=${err.questionCount}`);
    if (err.code === 'invalid-distribution' && err.actualTypeCounts && err.expectedTypeCounts) {
      const formatCounts = (counts) => ['technical', 'project', 'experience', 'behavioral']
        .map((type) => `${type}:${counts[type]}`).join(',');
      parts.push(`actual={${formatCounts(err.actualTypeCounts)}}`);
      parts.push(`expected={${formatCounts(err.expectedTypeCounts)}}`);
    }
  }
  return parts.join(' ');
}

async function generateQuestions(resumeContext) {
  const startedAt = Date.now();
  const interviewPlan = interviewPlannerService.buildInterviewPlan(resumeContext);
  const role = candidateData(resumeContext).targetRole;
  try {
    const prompt = buildQuestionPrompt(resumeContext, interviewPlan);
    const questions = await generateJsonWithRetry(prompt, role,
      (result) => validateGeneratedQuestions(applyPlannedMetadata(result, resumeContext, interviewPlan), resumeContext, interviewPlan));
    return { questions, source: `ollama-${OLLAMA_MODEL}` };
  } catch (err) {
    const fallback = heuristicFallbackQuestions(resumeContext, interviewPlan);
    debugGeneration({ stage: 'fallback-selected', role, startedAt, attempt: 0,
      durationMs: Date.now() - startedAt, questionCount: fallback.questions.length,
      ...safeRequestDetails(err), source: 'heuristic-fallback', category: questionGenerationDiagnostic(err) });
    return fallback;
  }
}

module.exports = { generateQuestions, heuristicFallbackQuestions, buildQuestionPrompt,
  generateCategoryQuestions, heuristicFallbackCategoryQuestions, buildCategoryQuestionPrompt };
