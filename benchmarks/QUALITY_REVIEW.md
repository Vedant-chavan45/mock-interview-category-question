# AI Interview Studio question quality review

Use this rubric for every benchmark set before comparing providers, models, prompts, or generation modes. Review all six questions as a set, then record a score from 1 (fails) to 5 (strong) and a short note for each row. Keep reviews with the benchmark configuration and run date; benchmark output uses only the synthetic fixture.

| Criterion | What to check |
| --- | --- |
| Technical correctness | The question describes a sound technical concept, mechanism, or practical problem. |
| Resume grounding | References to projects, skills, or work match the supplied resume evidence. |
| Role and skill relevance | Questions prepare for the target role and assess selected required skills without claiming they are candidate experience. |
| Category intent | All six questions fit their selected category and do not drift into a different category. |
| Depth | Questions invite useful explanation, reasoning, trade-offs, investigation, or evidence at the intended level. |
| Diversity | The six questions assess meaningfully different objectives and do not repeat one another or recent history. |
| Natural phrasing | Questions sound like something an interviewer would ask aloud and are easy to understand. |
| Factual restraint | Questions do not fabricate achievements, tools, employers, teammates, project features, or outcomes. |

Suggested review record:

```text
Date / run:
Category / role:
Provider / model:
Generation mode / prompt version / validator hash:
Model options / run count:
Technical correctness (1-5):
Resume grounding (1-5):
Role and skill relevance (1-5):
Category intent (1-5):
Depth (1-5):
Diversity (1-5):
Natural phrasing (1-5):
Factual restraint (1-5):
Rejected questions and reasons:
Reviewer notes:
```

Automated category validation and technical quality review can catch structural, grounding, and some topical problems, but cannot prove semantic correctness or interview usefulness. Review the exact question text manually before calling a run higher quality.

**Known Phase 2 risk:** compact technical generation uses deliberately relaxed semantic checks. It can accept technically weak or insufficiently relevant questions even when the output has six valid strings and passes current checks. Do not describe compact mode as adequate semantic quality assurance; compare it with the full mode and a stronger independent technical review before relying on it.
