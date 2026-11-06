# Phase 2A — Groq as an optional free-tier inference provider

This release adds Groq to the Phase 1 AI Model Gateway; Ollama remains the default.
Existing generation prompts, six category blueprints, validators, scoring rubric,
MongoDB schemas, and upgraded UI layout are unchanged. An incompatible provider
or an invalid response is **not silently accepted as an AI-generated question set**.

## Set up on Windows (PowerShell)

1. Work in the optimized project, not the original. Back up your existing version.
2. Install dependencies with `npm install` (or `npm ci` for a clean install).
3. Keep your existing `.env` file and add or update these lines:

```dotenv
AI_PROVIDER=groq
GROQ_API_KEY=your_private_groq_api_key_here
GROQ_MODEL=openai/gpt-oss-120b
GROQ_RESPONSE_FORMAT=json_schema
GROQ_REASONING_EFFORT=medium
AI_PERF_LOG_ENABLED=1
```

**Never** paste your real API key into chat, commit it, put it in `public/`,
or include `.env` in uploaded ZIPs. The downloaded project deliberately does
not contain an `.env` file. Copy only the required secret from your existing
local `.env` if needed, and keep your existing database and JWT configuration.

Only use Groq within the free plan shown in your own Groq console. Free-tier
quotas, model availability, and privacy terms can change; this integration does
not automatically enroll you in a paid plan or use billing APIs. Test with the
**synthetic** benchmark before using real resumes with a third-party model.

## Test the code (no API call or billing)

```powershell
npm run test:ai
npm test
npm run benchmark:ai -- --dry-run
```

The repository has **11 pre-existing test failures** in adaptive generation,
category generation, legacy mixed generation, and some UI-navigation assertions.
The Phase 2A test suite passed with those same 11 failures and no new ones in
our sandbox. Mock tests are not evidence of Groq question quality or speed.

## Benchmark the Groq free-tier model (uses API tokens)

```powershell
npm run benchmark:ai -- --category technical_concepts --runs 1
npm run benchmark:ai -- --category domain_fundamentals --runs 1 --include-evaluation
```

These tests use a synthetic resume and do **not** require MongoDB. They do make
real API requests and consume free-tier quota. Examine the generated questions:
technical correctness, real assessment depth, candidate-specific grounding,
required skill coverage, non-repetition, and diversity are the release criteria.
Keep the performance report and compare it with the existing Ollama baseline.
The model selection can be changed by editing `GROQ_MODEL`; quality must be
reviewed again for each model. Supported IDs and limits are on the Groq console.

**Provider metrics:** Groq returns token counts and, for some responses, timing
fields. Its schema-constrained mode is buffered, so a recorded first-content
callback represents the *completed response*, not true token-stream TTFT.
Missing per-stage timings are reported as unknown, not guessed.

## Troubleshooting and controllable settings

- `GROQ_API_KEY_MISSING` / `GROQ_AUTH_FAILED`: check your local key and account.
- `GROQ_MODEL_UNAVAILABLE`: choose a model available on your free-tier account.
- `GROQ_RATE_LIMITED` / HTTP 429: stop requests and wait for the quota reset;
  do not attempt to evade rate limits with multiple keys or automated retries.
- `GROQ_REQUEST_REJECTED`: verify your selected model supports JSON Schema.
  Set `GROQ_RESPONSE_FORMAT=json_object` if schema constraints are rejected;
  **existing application-side validation still runs** and may reject outputs.
- `GROQ_OUTPUT_LIMIT`: the model stopped before completing its response. You
  can set `GROQ_MAX_COMPLETION_TOKENS=3072` in `.env`, then rerun the benchmark.
- `GROQ_REASONING_EFFORT=medium` is the default for GPT-OSS models. Changing
  this setting can change both accuracy and latency and requires re-benchmarking.
- `QUESTION_GENERATION_TIMEOUT_MS` and `ANSWER_EVALUATION_TIMEOUT_MS` are still
  used by the original services; do not reduce them blindly.

To go back to local inference, change only:

```dotenv
AI_PROVIDER=ollama
```

Then restart the Node.js server. Do not delete `OLLAMA_MODEL` or the original
configuration. No automatic provider fallback is enabled, so failed Groq
requests never silently generate questions with another model.

## What Phase 2A does not claim

This is an **adapter and benchmark stage**. No actual Groq request was made in
our sandbox because the private key was not provided. Faster inference, better
question quality, or improved scoring have not yet been measured. The compact
technical-generation path's semantic validation is still a documented risk;
address it in the next quality-focused phase before production deployment.
