# CODEX IMPLEMENTATION PROMPT — PHASE 1

You are working as a senior Node.js engineer on a live project called **AI Interview Studio / Resume Intelligence**. Work directly in the currently opened local folder **`resume-interview-project-optimized`**, NOT in the original `resume-interview-project-improved` folder. The optimized folder was copied from the most recent working project; the public GitHub repo may be older. Inspect the ACTUAL local source before coding.

## Goal

Implement a **safe, behavior-preserving foundation** for AI performance optimization: (1) one extensible model-provider gateway with an Ollama adapter, (2) complete privacy-safe inference telemetry, and (3) reproducible local benchmarking and question-quality review tools. This is **Phase 1 only**, not the complete optimization. It must prepare the project for future free hosted provider integrations and modular prompt/validator upgrades **without weakening question quality or breaking the current UI**.

**Non-negotiable priorities:** quality and personalization first; evaluation accuracy second; latency third; entirely free development/testing fourth; maintainability and deployability throughout. Do not substitute generic templates or a weaker AI model. Do not treat speed improvements as proven without measurements.

## Existing app — read and preserve

- Node.js/CommonJS + Express, native HTML/CSS/JS UI, Mongoose/MongoDB, Ollama with Llama 3.2 by default; Node test runner (`npm test`).
- Six interview category IDs in `src/services/questionCategories.js`: `domain_fundamentals`, `technical_concepts`, `project_deep_dive`, `professional_experience`, `applied_scenarios`, `behavioral_collaboration`. Each category produces **exactly six** customized questions based on candidate resume evidence, target role, employer-required skills, category, and rotation history.
- Main code paths:
  - `src/services/questionGeneratorService.js` (~1,977 lines): builds plans/prompts, uses Axios to call Ollama `/api/generate` with **streaming**, structured JSON schema, abort, timeouts, and metrics; validates/repairs responses; tracks prior questions. Contains `enqueueCategoryGeneration()` global Promise queue and a memory cache. Technical category has compact default and full generation mode (`QUESTION_GENERATION_MODE=full`). **Do not change either mode or validators in Phase 1.** Note: compact mode presently under-validates semantic/technical quality; DOCUMENT as a risk, never claim it provides adequate quality assurance.
  - `src/services/answerEvaluationService.js`: a separate non-streaming Axios Ollama call with JSON schema, zero-credit handling, quoted-answer evidence validation, score from **0 to 10** in **0.5 increments**, and feedback. It does not currently expose Ollama timing metrics.
  - `src/services/ollamaService.js`: non-streaming Ollama calls for resume analysis, JSON retry, explicitly labelled heuristic fallback if Ollama unavailable.
  - `src/controllers/resumeController.js`: owns category generation/evaluation workflows, active-operation guards, ownership checks, MongoDB persistence. It checks that successful generation source equals `ollama-${result.model}`; preserve that legacy source identity for Phase 1. It protects against attaching evaluations to regenerated questions and saves answers even after evaluation errors.
  - `src/services/categoryBlueprintService.js`, `interviewPlannerService.js`, `skillAssessmentPlanner.js`, `questionRotationService.js`, `questionValidatorService.js`, `questionQualityService.js`: all encode valuable quality/planning behavior. Keep intact.
  - `public/index.html`, `public/js/app.js`, `public/css/*`: recently upgraded UI. **Do not redesign or alter the UI** in this phase.
- Auth, ownership, and API contracts MUST remain unchanged, particularly:
  - `POST /api/resume/:id/questions/:category`
  - `POST /api/resume/:id/questions/:category/:questionIndex/evaluate`
  - Existing practice restore, resume upload, login and signup.
- Existing quality constraints: resume-grounded questions; required skills are interview targets **not claims** of experience; no fabricated resume achievements; diverse category-specific questions; no unvalidated AI-generated fallback questions; irrelevant/gibberish/score-begging answers earn zero; no credit without supporting evidence; handle correct but concise answers fairly.
- Existing `test/fixtures/syntheticInterviewResume.js` provides **synthetic, non-private** benchmark data; `test/liveOllamaCategories.js` provides an existing optional live category test.
- Existing `package.json` uses CommonJS, `npm test`, and Node's built-in test runner. There may already be unrelated failing tests (previous snapshot had 149/160 default and 156/160 in full mode). Record BASELINE failures first, then compare. Do not weaken/remove tests to get green.
- The local `.env` may contain secrets. **Never print, read back into your final answer, modify, commit, or expose `.env` values.** Review `.env.example` only for safe settings.

## Work package A — model-provider gateway, zero behavior regression

1. Add a small, testable module boundary under `src/ai/`, e.g.:
   - `src/ai/config.js`
   - `src/ai/modelGateway.js`
   - `src/ai/providers/ollamaProvider.js`
   - `src/ai/telemetry.js`
   Adapt naming if actual code supports a better minimal design; explain deviations.
2. The **only enabled provider in this phase is Ollama**. Add `AI_PROVIDER=ollama` (default) to `.env.example`; do not require new credentials or SDKs. An unsupported provider must fail explicitly and safely, NOT silently switch to Ollama or pretend to produce AI output.
3. Create a clear provider interface capable of supporting BOTH structured streaming generation and non-streaming structured generation/analysis with prompt, schema/format, model, options (`num_predict`, `num_ctx`, temperature, keep-alive), timeout, abort signal, and optional first-chunk callback. Preserve full Ollama response metadata: `eval_count`, `prompt_eval_count`, `load_duration`, `prompt_eval_duration`, `eval_duration`, `total_duration`, `done_reason`.
4. Move/wrap the actual Ollama HTTP transport in the provider module; use the gateway at the three existing service entry points: question generation, answer evaluation, resume analysis. **Do not rewrite the 1,977-line generator** or migrate its planning/prompt/validation logic. Keep the adapters straightforward. Preserve differences in streaming/non-streaming requests and existing per-operation model options. Ensure streaming handles chunk boundaries and cancellation correctly.
5. Preserve legacy exports and contract behavior: `generateCategoryQuestions()`, `evaluateAnswer()`, `analyseResume()`, and existing test-visible helpers and result shapes must remain compatible. In particular preserve successful question output's `source: ollama-${model}`, model IDs, cache behavior, retry semantics, error mapping, answer-evaluation lock, and exact score rules. Do not change prompt strings, schema structure, validators, output token ceilings, generation mode, queue implementation, or UI.
6. Make the gateway useful for a later free provider adapter (Groq/Gemini or other), but **DO NOT** implement any paid integration now and do not stub fake question results.

## Work package B — privacy-safe timing instrumentation

1. Record **per model call**: anonymous request ID, operation (`resume_analysis`, `category_generation`, `answer_evaluation`), provider, model, category ID when known, stage (planning/generation/review/repair/evaluation when known), success/failure category, elapsed wall time, time to first chunk/token when available, Ollama load/prompt-processing/decode/total durations converted from nanoseconds to ms, prompt token count, generated token count, retry count when known. Question workflow metrics should also include queue-wait, cache-hit, validation, repair, and end-to-end time where available.
2. Multi-call technical generation needs per-call observations AND an aggregate; do not report only the last request as if it represents the whole pipeline.
3. Add a simple opt-in env flag (e.g. `AI_PERF_LOG_ENABLED=1`). When enabled, emit structured **metadata-only** JSON lines to stdout or a gitignored local results file; when disabled, avoid verbose logs and keep overhead small. If writing files, do not block/fail the user request when logging fails. Use consistent units and documented field names; use `performance.now()` / monotonic time when appropriate. Only emit p50/p95 when sample size makes it meaningful; include sample counts.
4. Never log raw resume text, user names, contact details, target-role descriptions, user answers, question content, prompts, completions, tokens/headers, Authorization, API keys, MongoDB URI, or upstream raw error bodies. Do not leak these via error stacks in public HTTP responses.
5. The answer evaluator currently discards inference timings. Add internal telemetry **without changing the persisted evaluation schema or frontend response** unless a tiny optional field is provably safe and backward-compatible. For deterministic zero-credit (no model call), record it as a bypass rather than inference latency.
6. If model runtime metrics are absent from a mocked response, handle gracefully with null/omitted values. Do not invent them.

## Work package C — reproducible benchmarking and quality review

1. Add a documented **opt-in local benchmark script**, ideally `scripts/benchmarkAI.js`, and npm command `npm run benchmark:ai -- --category technical_concepts --runs 1` (adapt CLI syntax if necessary). It should construct the `resumeContext` from `test/fixtures/syntheticInterviewResume.js` and existing `contextBuilder`, then use the **actual existing generation/evaluation service**, not invented mock model output, when live mode is selected.
2. Support `--category <one of six IDs | all>` and `--runs N` with validation. Default to one category, one run; requiring `--category all` avoids accidentally issuing six ~100-second model requests. Force fresh generation in the real benchmark, and report whether any cache was hit. A non-inference `--dry-run` preflight must work without Ollama or MongoDB. Use a single, synthetic candidate answer for evaluation, optionally gated by `--include-evaluation`; never need a real resume or database.
3. Show per-run operation, category, outcome, wall-clock time, queue wait, model timing breakdown, generated token counts, retries, validation and model metadata. Show aggregate statistics (min/mean/median/p95 with sample count, with p95 labelled exploratory for small n). Handle timeouts and invalid output without treating them as successful results. Exit nonzero for failed requested live benchmark runs, but with useful safe error codes.
4. Provide a **human-reviewable quality rubric**, e.g. `benchmarks/QUALITY_REVIEW.md`: technical correctness, specific grounding in the resume, role/required-skill relevance, correct category intent, depth, question diversity, natural interview phrasing, and zero fabricated achievements. Explain that automated checks alone cannot prove semantic quality. Flag compact technical generation's incomplete semantic checking as an outstanding Phase 2 issue.
5. Ensure future runs can be compared fairly: same fixtures, same category, generation mode, selected model/provider, prompt and validator version, model options, run count, and recorded qualitative review. If writing output snapshots, use only synthetic data and gitignore run-specific results. Never silently cache/reuse a fresh benchmark output.
6. Add `docs/AI_OPTIMIZATION_BASELINE.md` (or similar), covering architecture, how telemetry works, commands for Windows PowerShell, how to collect `ollama ps` and GPU-offload information, bottlenecks still unmeasured, realistic free-tier and local hardware limits, and a Phase 2 plan. Do not assert cloud APIs are unlimited/free forever or claim 5–15s latency is achieved without measurement.

## Work package D — tests and verification

1. Run `npm test` BEFORE editing; record test count and baseline failures (with names) in your final report. Do not claim failing baseline tests are regressions.
2. Add focused Node test-runner tests for provider transport (streaming, buffered response, JSON schema, model/options passthrough, timeout and cancel), gateway unsupported-provider rejection, Ollama timings -> milliseconds, missing metrics, no private text in logs, eval 0–10 half-points including zero, irrelevant and score-begging answers, output source compatibility, benchmark `--dry-run`, and unchanged category APIs. Reuse existing mocking style (`node:test`, `t.mock`, axios).
3. Run `node --check` on each changed JS module; `npm test`; the benchmark `--dry-run`; and any focused tests. Only run real Ollama benchmarking if the Ollama server/model is available. Never fabricate live latency measurements.
4. Compare AFTER vs BEFORE test failures. The change is unacceptable if it adds unexplained failing tests or drops quality safeguards. Do not delete/suppress tests or alter unrelated functionality to make them pass.
5. Check that no dependency or paid API key is required for `npm start`; `.env` remains untouched; UI unchanged; existing MongoDB data shape unchanged; source does not leak PII into telemetry; no autonomous Git push/deployment.

## Explicitly OUT OF SCOPE for Phase 1

- No cloud GPU/vLLM, Redis/BullMQ, microservices, Kubernetes, paid services, or automatic external AI calls.
- No Groq/Gemini API integration yet (prepare adapter interface only).
- No model replacement, quantization change, inference tuning, token-budget reduction, prompt rewrite, question shortening, generic template fallback, or weaker validator.
- No new UI layout, auth changes, API redesign, database migration, unrelated refactoring, or weakening quality checks.
- Do not address known compact-mode quality gaps with shortcuts. They are a tracked follow-up task.

## Definition of DONE

The optimized copy still runs as before with Ollama; answers/questions, category-specific customization, grading, persistence and current UI remain backward compatible; all AI calls flow through a configurable/provider-neutral entry point; there is metadata-only timing for both generation and evaluation; synthetic benchmarks can run without MongoDB and can be dry-run without Ollama; a human-review quality rubric exists; no new unexplained test failures are introduced; the system remains free to run locally and easy to extend with a free-tier provider in Phase 2.

## Required final Codex response format

Provide:
1. Summary of architecture changes, including an ASCII diagram.
2. Exact list of changed/new files and what each does.
3. Before/after test results, distinguishing old failing tests from new regressions.
4. Exact PowerShell commands from the optimized project root to start the app, run focused tests, run benchmark dry-run, and run a real Ollama benchmark.
5. Example **synthetic/metadata-only** telemetry event and how to interpret its timing fields.
6. Any unimplemented requirement, risks, or uncertainty; specifically call out that no measured quality/latency gain is claimed yet.
7. Suggested Phase 2 changes (free provider adapters, rigorous technical semantic validation, and speed/quality comparison) WITHOUT implementing them now.

Do the work end-to-end on the local optimized project. Do not stop after a plan or ask questions already answered here. If the existing code makes one requirement impractical, implement the safest smaller version, document the trade-off, and preserve all user-visible behavior.
