# Phase 2C: Evidence-grounded interview quality

This patch is built on Phase 2B **hotfix** (and the Phase 2A Groq adapter). It does not replace scoring, the six categories, or the working UI.

## Why this exists

A project title in a question is **not** personalization. Good personalized project questions connect a documented operation, tool, responsibility or design decision to an interview-relevant assessment. Fundamentals and technical-concept questions do **not** need project names; they need appropriate required-skill and role coverage. Behavioral questions must not fabricate past events.

## Files to edit when question quality needs to improve

- `src/ai/quality/interviewStandards.js`: category purpose, what a good question tests, resume-evidence card rules, and separate objectives for generic/backend/full-stack fundamentals.
- `src/ai/quality/interviewReviewer.js`: optional independent semantic reviewer rubric, allowed issue codes, and single-batch repair prompt.
- `src/ai/quality/categoryPolicies.js`: previous short category guidance and compact technical quality settings (retained).
- `src/services/questionGeneratorService.js`: writes six questions from role, required skills, evidence cards and slot objectives. The prompt version/cache key changes to `interview-evidence-v1`; targeted repair does not force a project keyword.
- `src/services/questionCategories.js`: behavioral objectives no longer presume that a disagreement, negative feedback or a mistake actually happened.
- `src/controllers/resumeController.js`: shares the **last 24 questions** from other categories for diversity while retaining the category-specific generation index/history.

## Optional AI quality review

Add to your local `.env` (do not upload it):

```env
AI_INTERVIEW_REVIEW_ENABLED=1
```

This makes an extra structured-review request after generation and ordinary validation. The reviewer checks category fit, specificity, evidence-grounding, degree of personalization, technical soundness, difficulty, and overlap with current/other categories. It must only reject material defects; valid questions aren't rejected simply because they could be phrased differently. If a subset fails, only those questions are repaired, and the **entire batch is reviewed again**. Questions still judged invalid fail explicitly without replacing good persisted questions.

**Important:** Keep review disabled (`0`) during initial smoke testing, then enable for a small, curated comparison. Each review/repair consumes free Groq quota, adds latency and may occasionally reject a good question; neither model-based review nor deterministic checks guarantee technical truth. Monitor false positives and rubric quality. The old compact technical gate remains active regardless of this flag.

## Before applying

Back up `resume-interview-project-optimized` or commit it to Git. The patch is based on the Phase 2B hotfix. Merge cautiously if you made later manual changes.

## Validate on Windows

```powershell
npm run test:quality:2c
npm test
npm start
```

Run one category with synthetic inputs:

```powershell
$env:AI_PERF_LOG_ENABLED='1'
npm run benchmark:ai -- --category technical_concepts --runs 1
npm run benchmark:ai -- --category domain_fundamentals --runs 1
```

Also test through the UI with a **real resume and all six category outputs**. Regenerate one category after others exist. Check for reused competencies across categories. For reviewer validation, set `AI_INTERVIEW_REVIEW_ENABLED=1` in `.env` and restart. Do not paste raw resume, personally identifying information or API secrets into logs or external reports.

## Quality rubric for human review

Rate 0–5 on: (1) actual role fit, (2) competency/category match, (3) technical precision, (4) depth suitable for the candidate, (5) *evidence-grounded* personalization where relevant, (6) real interview answerability, (7) diversity within and across categories, (8) no fabricated resume/past-event claims. Block release if serious fabrication, technical false premise, or systemic category mismatch occurs. Compare with existing questions under the same candidate profile and required skills. Recorded latency and reviewer decisions alone are **not proof** of quality gains.

## Compatibility and verification limits

- No migrations or new npm dependencies.
- No actual Groq calls are performed by automated tests.
- The original test suite had known legacy failures (11 per previous Phase 2B report); compare new failures separately rather than editing assertions to hide them.
- This package was syntax-checked; its standalone and mocked-provider targeted tests passed. The **complete local automated suite ran: 191 passed, 11 failed, 202 total**. The 11 failing test names match the previously reported legacy failures. No live Groq request was performed (your local API key is not present here).
