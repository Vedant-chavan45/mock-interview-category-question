Behavioral / category wording flexibility patch

Apply this patch over the existing resume-interview-project-improved project root.
It updates only these files:
- src/services/questionValidatorService.js
- src/services/questionGeneratorService.js
- src/services/questionCategories.js
- src/services/categoryBlueprintService.js
- test/categoryQuestions.test.js

What changed:
- Removed category/slot wording checks. There is no HYPOTHETICAL_CUE,
  questionFitsCategory, invalid-slot-intent, or invalid-category-relevance gate.
- Removed slot intent regex metadata. The selected category and six natural-language
  blueprint objectives guide generation; wording is not matched against regexes.
- Natural question openings and phrasing are accepted, including "If ...",
  "Have you ever ...", "Tell me about ...", direct scenarios, and longer questions.
- The exact previously rejected Behavioral & Collaboration question is covered by
  a mocked end-to-end generation test that verifies no repair request is made.
- The prompt version is incremented so old cached output is not reused.

Safeguards retained:
- Exactly six questions and valid response structure.
- Empty/oversized output and duplicate detection.
- Server-owned slot/evidence metadata and evidence-reference integrity.
- Unsupported resume technologies, invented job/employer claims, and unsupported
  quantitative past claims are still rejected.

Category fit is guided by the selected category prompt and ordered blueprint slots.
The validator deliberately does not guess category meaning from wording patterns.

After extraction in the project root, run:
  npm test
  npm start

Then test Behavioral & Collaboration in the UI. This patch has automated-test
verification only; it has NOT been verified against the user's local Ollama runtime.
Do not overwrite .env, package-lock.json, or node_modules.
