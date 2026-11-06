# AI optimization foundation and measurement baseline

This Phase 1 change adds a provider boundary and opt-in metadata-only timing. It does not change prompts, token ceilings, model selection, generation mode, validators, the UI, persistence, or the category APIs. No live inference benchmark or human quality comparison was run as part of this change, so there is no measured latency or quality gain to report.

## Architecture

```text
resumeController / CLI benchmark
        |
        +--> questionGeneratorService (streaming, category_generation)
        +--> answerEvaluationService (buffered, answer_evaluation)
        +--> ollamaService (buffered, resume_analysis)
                         |
                    modelGateway
                provider selection/config
                         |
                  ollamaProvider
          Axios, JSON/NDJSON, abort, timeout
                         |
                  local Ollama API

modelGateway --> privacy-safe telemetry --> optional JSONL stdout events
benchmarkAI --> synthetic fixture + existing services (no MongoDB)
```

`AI_PROVIDER` defaults to `ollama`. The gateway registry makes another adapter possible, but Ollama is the only registered provider in this phase. An unknown provider returns `AI_PROVIDER_UNSUPPORTED`; it does not fall through to Ollama. The Ollama adapter supports both structured streaming and buffered calls and retains Ollama's token counts, nanosecond durations, and `done_reason` when provided.

The category generator still owns prompt construction, planning, rotation, queueing, cache behavior, validation, repair, and source identity (`ollama-${model}`). It continues to produce six customized questions for each of the six current category IDs. The answer evaluator keeps its existing 0–10 half-point score rules, evidence checks, deterministic zero-credit path, return shape, and persistence behavior. Resume analysis retains its JSON retry and explicitly labeled heuristic fallback when Ollama itself is unavailable.

## Telemetry

Set `AI_PERF_LOG_ENABLED=1` to write one metadata-only JSON object per model call and operation to stdout. The default is `0`. Failed writes or console logging cannot fail a request. The benchmark can also observe these already-sanitized events in-process without enabling stdout logging.

Each inference event uses a random request ID and includes operation, provider, model, known category ID, stage, outcome/failure category, wall time, time to first streamed chunk when available, Ollama load/prompt/decode/total durations in milliseconds, prompt and generated token counts, retry count, and safe numeric model options. Ollama nanoseconds are divided by 1,000,000. Missing runtime values remain `null`; the code does not estimate them. Buffered calls do not report a time-to-first-chunk value.

Category operation events also report end-to-end time, queue wait, cache hit, validation, repair, planning/review time, model-call count, and summed model timings. Technical planning/generation/review/repair calls emit separate observations as well as the category aggregate. A deterministic score-request-only answer emits a bypass event with zero model calls; it is not recorded as inference latency.

No event contains prompts, completions, resume text, names, contact details, role descriptions, answers, question content, headers, credentials, raw upstream error bodies, or stack traces. Model/category/stage labels are restricted to safe identifiers and model options are numeric or a validated keep-alive duration.

Example synthetic event:

```json
{"event":"ai.inference","requestId":"31f6e820-31a7-4ad6-85ef-8c939508326c","operation":"category_generation","provider":"ollama","model":"llama3.2:latest","categoryId":"domain_fundamentals","stage":"generation","outcome":"success","failureCategory":null,"elapsedMs":8421.55,"timeToFirstChunkMs":911.27,"loadMs":182.4,"promptProcessingMs":744.8,"decodeMs":6841.2,"modelTotalMs":7980.6,"promptTokens":1378,"generatedTokens":184,"retryCount":0,"modelOptions":{"numPredict":512,"numContext":8192,"temperature":0.2,"keepAlive":"10m"}}
```

`elapsedMs` measures the request at the application boundary; `loadMs`, `promptProcessingMs`, `decodeMs`, and `modelTotalMs` come from Ollama. They may not sum to wall time because they cover different work and measurement boundaries. The example is illustrative, not a measured run. Percentiles are reported by the benchmark with sample counts; p95 is marked exploratory for fewer than 20 successful samples.

## Commands from the optimized project root (PowerShell)

Start the existing web app (it still needs its configured MongoDB and Ollama setup):

```powershell
npm start
```

Run all tests and focused provider/benchmark tests:

```powershell
npm test
npm run test:ai
```

Run a no-inference, no-database preflight:

```powershell
npm run benchmark:ai -- --dry-run
npm run benchmark:ai -- --dry-run --category technical_concepts --runs 2
```

Run actual generation on the synthetic fixture. A live run requires local Ollama and the configured model; it calls the real generation service and forces a fresh generation:

```powershell
npm run benchmark:ai -- --category domain_fundamentals --runs 1
npm run benchmark:ai -- --category technical_concepts --runs 1
npm run benchmark:ai -- --category all --runs 1
npm run benchmark:ai -- --category domain_fundamentals --runs 1 --include-evaluation
```

Collect metadata-only JSON lines during an explicit live run:

```powershell
$env:AI_PERF_LOG_ENABLED = '1'
npm run benchmark:ai -- --category technical_concepts --runs 1
$env:AI_PERF_LOG_ENABLED = '0'
```

For fair comparisons, keep the fixture, category, generation mode, provider/model, prompt version, validator SHA-256, model options, and run count the same. Do not compare one cached result with a forced fresh result. Use `benchmarks/QUALITY_REVIEW.md` to review the question text; automated acceptance is not a semantic quality score.

## Local runtime and bottleneck collection

Before a live benchmark, record the model and GPU assignment reported by Ollama:

```powershell
ollama ps
```

On NVIDIA systems, capture GPU utilization and memory during the run if `nvidia-smi` is installed:

```powershell
nvidia-smi --query-gpu=name,utilization.gpu,memory.used,memory.total --format=csv
```

Windows GPU inventory is also available through:

```powershell
Get-CimInstance Win32_VideoController | Select-Object Name,AdapterRAM,DriverVersion
```

Record model quantization/context settings using the local Ollama model information and keep them constant between runs. Do not put resume content or answers into benchmark notes.

Still unmeasured until a live local run is collected: model load versus warm inference, prompt processing versus decoding, CPU/GPU offload, queue contention, technical multi-call planning/review/repair cost, output-validation cost at larger run counts, and resume parsing/database latency outside model inference. A local model is bounded by available memory, compute, storage, and power. Any future hosted free tier may impose quotas, rate limits, availability changes, or data-use terms; this phase adds no hosted integration and makes no unlimited-free assumption.

## Phase 2 follow-up

1. Add a free hosted provider adapter only after verifying its current free-tier limits, privacy terms, structured output support, streaming behavior, and cancellation semantics. Keep Ollama as an explicit local option.
2. Improve technical semantic validation with independently reviewed correctness and relevance checks while preserving the full resume-grounding and category validators. Investigate the compact-mode semantic gap before changing default behavior.
3. Compare providers and modes on the same synthetic and consented evaluation fixtures, with repeated warm/cold runs, recorded hardware/offload, token counts, failure rates, and blinded human quality reviews. Select changes only from measured quality and latency evidence.


## Phase 2A addendum — optional Groq inference

Phase 1 documented the Ollama-only behavior at the time it was written. Phase 2A
adds an optional `groq` provider. Ollama remains the default. See
`docs/PHASE2A_GROQ_SETUP.md` for configuration, free-tier restrictions, and
quality-first verification. Phase 1 reference measurements are unchanged.
