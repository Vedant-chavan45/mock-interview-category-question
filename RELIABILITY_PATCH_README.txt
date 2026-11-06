AI INTERVIEW STUDIO — RELIABILITY AND SECURITY PATCH
===================================================
Based on Phase 2C project source. Patch ZIP contains ONLY changed/new files.
Does not contain your PDF, API keys, .env, node_modules or Git history.
Does NOT overwrite CSS theme customizations.

FROM PowerShell in the project root:
  Expand-Archive "$HOME\Downloads\AI_Interview_Studio_Reliability_Security_Patch.zip" -DestinationPath . -Force
  npm test
  npm start

Result: POST /api/resume/validate runs immediately when a PDF is selected,
and POST /api/resume/upload repeats the same resume-only check server-side.
This version requires a verified PDF before the Analyze button is enabled.

Read docs/RELIABILITY_SECURITY_AUDIT.md for the exact changes, tests, risks,
production configuration and remaining limitations.
