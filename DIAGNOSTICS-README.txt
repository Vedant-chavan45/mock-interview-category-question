DIAGNOSTICS-ONLY PATCH
======================

This patch does not change question prompts, validation rules, generation behavior,
configuration, dependencies, or stored resume data. It only makes the server log
show the validator's existing safe diagnostic (failure reason, question index,
and slot ID). The rejected question text is logged only when the local verbose
flag is explicitly enabled.

Apply from the project root by extracting this ZIP into the project folder.
Then, in the same PowerShell window, run:

  $env:DEBUG_QUESTION_GENERATION_VERBOSE = '1'
  npm start

Reproduce the Domain Fundamentals failure once. The server terminal should show:
  [resumeController.generateCategoryQuestions] ... reason=question-validation-error reason=invalid-slot-intent questionIndex=N slotId=SLOT_ID ...
  [resumeController.generateCategoryQuestions] rejectedQuestion="..."

Share only those two lines. They contain the rejected generated question, not the
resume itself. The verbose flag is process-local and is not written to .env.
After debugging, close that PowerShell window or run:
  Remove-Item Env:DEBUG_QUESTION_GENERATION_VERBOSE

This patch was checked with node --check and the full project test suite (127/127).
