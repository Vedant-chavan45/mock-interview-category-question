INTERVIEW QUESTION QUALITY-FIRST PATCH

Purpose
- Removes narrow slot-by-slot keyword validation that rejected natural questions.
- Uses broad category-level cues instead of requiring exact slot wording.
- Preserves six-question structure, duplicate checks, readable length/punctuation,
  resume evidence IDs/provenance, unsupported technology checks, unsupported
  past-claim checks, and explicit hypothetical/behavioral distinction.
- Improves performance-word matching for normal inflections such as "slows".
- Increments the prompt cache version so previously cached question sets are not
  reused after this prompt/validator change.

Files included
- src/services/questionValidatorService.js
- src/services/questionGeneratorService.js
- src/services/questionCategories.js
- test/categoryQuestions.test.js

Apply
1. Stop the app with Ctrl+C.
2. Back up your current project folder or at least the four target files.
3. Extract this ZIP into the project root, allowing it to overwrite these files.
4. Run: npm test
5. Run: npm start
6. Regenerate Role & Domain Fundamentals. The exact question below is covered by
   a regression test and is accepted for a Backend Developer role:
   "What would you check first when an application slows down during peak usage?"

This patch does not include or overwrite .env, package.json, package-lock.json,
node_modules, uploaded resumes, or other user data.

Verification performed in the packaged source tree
- npm test: 130 passed, 0 failed.
- node --check for JavaScript files under src, test and public/js: passed.
- Direct validator regression for the exact reported Backend Developer question:
  accepted as a question in a six-question Domain Fundamentals set.

Live Ollama verification against the user's Windows localhost was not performed
from this environment. Run the UI with Ollama locally to confirm the model output.
