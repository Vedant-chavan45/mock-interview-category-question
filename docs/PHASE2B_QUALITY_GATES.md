# Phase 2B: Quality-first category controls and compact technical gate

## What changed

- Six independent, editable quality profiles live at `src/ai/quality/categoryPolicies.js`. Edit `focus` for one category to change its generation instructions without modifying its other five categories or switching provider.
- Technical Skills & Concepts *compact* generation now validates answerability/length, question form, genuine topic-label grounding, existing technical quality rules, near duplicates within the batch, and previously asked near-duplicates. False claims of prior experience with an undocumented employer-required skill remain invalid. Accepted questions retain server-owned slot/evidence metadata.
- Failures include the offending slot index. The existing targeted repair path can replace **only that slot**, up to the bounded `TECHNICAL_RULES.maxRepairs` (one by default); it does not silently replace the whole batch or use a static question bank.
- Compact technical prompts include **only project technology names** as secondary resume context; employers, contact details and project descriptions are not added.
- The other five category prompts now read `CATEGORY QUALITY FOCUS` from the independent profiles. Their established validators and server-side blueprints remain in place.
- Code-based knobs: `minWords`, `maxWords`, `minTopicWords`, `maxTopicWords`, `similarQuestionJaccard`, and `maxRepairs` in `TECHNICAL_RULES`.

## Quality limitations / release gate

These are conservative heuristics, **not a verified semantic correctness or personalization benchmark**. The model may generate a plausible but technically incorrect question that passes lexical checks; an independent model or expert review and a manually scored representative fixture set are still needed. A strict label check may request repair for a technically good question with an inaccurate model-authored topic label; the repair prompt explicitly asks to keep the question if sound and fix the label only.

Before promoting this version, compare **all six categories** across varied resumes and required skill sets against Phase 2A. Review technical validity, grounded claims, target-skill prioritization, category intent, diversity, and entry-level suitability. Reject regression even if output is faster. Record total latency and repair counts. Initial benchmarks used a single test per category and are not p95 evidence.

## Local PowerShell verification

```powershell
cd "C:\Users\vedan\Downloads\resume-interview-project-improved\resume-interview-project-optimized"
npm install
node --test test/phase2bQuality.test.js
npm test
$env:AI_PERF_LOG_ENABLED='1'
npm run benchmark:ai -- --category technical_concepts --runs 1
npm run benchmark:ai -- --category domain_fundamentals --runs 1
```

The live commands use the configured AI provider and may consume **free-tier API quota**. Review generated questions, not merely exit status. Do not commit `.env` or API keys. Run the other four categories before declaring a production-ready quality improvement.

## How to tune quality

1. Edit only the relevant `CATEGORY_POLICIES.<category>.focus` guidance.
2. If false positives occur in compact mode, review `compactTechnicalGate.js` and tune the **specific threshold**, not all validation off.
3. Re-run the fixtures and save example accepted/rejected outputs before changing providers or model settings.
4. If a rubric/technical reviewer is added in a later iteration, make it explicit, quality gated and measurable (review calls consume provider quota).

**No external dependencies were added; the UI, existing REST APIs, data schemas, scoring, and Groq/Ollama adapter selection were not changed.**

## Phase 2B hotfix — multiple rejected slots (2026-11-04)

- Reproduced the reported live failure: the first rejected technical slot used up the **single repair allowance**, so a second rejected slot caused the entire batch to fail even though Groq answered successfully.
- The validator now gathers **all** invalid technical slots in one pass. The generator requests replacements for those slots **in one structured repair response**, preserves accepted questions, and validates the complete set again.
- `TECHNICAL_RULES.maxRepairs` now means the number of **batch repair rounds** (default: two), not the number of rejected questions. This is strictly bounded; no invalid batch is silently accepted and there is no fallback question bank.
- Exhausted quality checks return `QUESTION_QUALITY_REJECTED`, surface `question-quality-rejected` rather than `ai-unavailable`, and emit `quality_rejected` telemetry with actual model-call and repair counts. Provider errors are still propagated separately.
- New regression tests in `test/phase2bBatchRepair.test.js` cover two independently rejected slots, preservation of accepted questions, bounded failure on unrecoverable output, and reporting multiple issues.

Verify locally without API calls:

```powershell
node --test test/phase2bQuality.test.js test/phase2bBatchRepair.test.js
npm test
```

Then, if the tests pass, retry the real category in the web UI. This can use additional Groq free-tier calls when the quality gate rejects questions. No live Groq call was run in this development environment.
