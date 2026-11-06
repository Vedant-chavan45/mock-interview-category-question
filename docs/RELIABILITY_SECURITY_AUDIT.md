# Reliability and Security Audit — Post Phase 2C

This patch is based on the **Phase 2C project ZIP**, not on the user's machine's subsequently edited CSS. It does not overwrite theme files, database records, or `.env`.

## Fixed, with verification

1. **Resume-only PDF intake** — Added `POST /api/resume/validate` behind JWT auth. The browser checks a selected file immediately, showing a clear rejection and disabling Analyze until successful validation. The final upload separately repeats all validations, so direct API clients cannot bypass preflight. It checks actual PDF magic bytes, extracted text, and multiple substantive resume sections. The validator is deterministic and makes **zero LLM calls or DB writes** until acceptance.
2. **False PDF claims and resource bounds** — MIME alone is not trusted; a PDF signature is required. Limits remain 5 MB, plus max 10 pages and 100,000 extracted characters. The `pdftotext` fallback has a 15-second process timeout and deletes temporary files even on failure. Multipart fields and parts are bounded.
3. **Changing the target role clears selected required skills** — Handles dropdown, custom roles and typed changes, with immediately updated chips, suggestions and disabled Analyze state. Previous saved interview results remain associated with their original context until the user analyzes a new resume.
4. **Certification parsing** — Fixed bullet-only and wrapped certification lists; detects all four certifications in the supplied real example. Uses deterministic parsing; certificates are not inferred by the LLM.
5. **CORS and browser headers** — Default same-origin access; cross-origin access only from configured `CORS_ALLOWED_ORIGINS`. Added `nosniff`, clickjacking and referrer protection, disabled Express identification, and disabled HTTP caching on API responses.
6. **Auth brute-force resistance** — Local login/signup request throttling: 25 login requests per 15 min per IP, 10 signup requests per 15 min per IP. Uses `Retry-After`, capped in-process memory. For real multi-instance hosting, move limits to shared storage and configure trusted proxy hops explicitly.
7. **Development network exposure** — `npm start` binds localhost by default outside production, so an unmodified demo account is not casually exposed to other machines on the LAN. Explicit `HOST` overrides remain available for intentional networking.
8. **Production identity protection** — Refuse production startup without a strong, non-default `JWT_SECRET`. Don't seed the demo account in production unless explicitly enabled, and reject default demo credentials when enabled. Existing seeded demo accounts in a reused production database MUST be reviewed/removed manually.

## Verification

- `npm test`: 200 passing / 211 total; exactly the same 11 pre-existing failures as the original Phase 2C suite (191/202).
- Nine new regression tests pass: certification formats, resume classification, PDF signature, early rejection without AI/DB, production secret checks, role-change behavior, login throttle, browser security headers, authenticated HTTP preflight.
- HTTP smoke test rejects an actual non-resume PDF with **422 / not-a-resume**, rejects a forged PDF with **422 / unreadable-pdf**, and never reaches the AI.
- Your uploaded text-based PDF is recognized as a resume, and all four certification entries are extracted. It is **not included** in the distributed project or test fixture.
- The existing test `test/sample_resume.pdf` is accepted by the preflight and the new included synthetic Java-assignment PDF is rejected.

## Limitations and further work

- A heuristic classifier cannot perfectly distinguish every resume from every document. Creative/heading-free resume layouts and scanned PDFs can be rejected; there is no OCR. Test varied real resumes before deployment. A future optional review path should not silently accept documents that fail validation.
- File signature checks and the PDF parser are **not** malware scanning or a sandbox. For public deployment, isolate parsing resources, keep dependencies current, and add malware/content scanning if threat modeling warrants it.
- Login throttling and generation locks use in-process state, so do not coordinate between multiple server replicas. A distributed cache/rate limiter is needed to claim multi-instance protection.
- JWTs remain in browser `localStorage` under the current architecture. An XSS vulnerability would endanger bearer tokens; consider migrating to HttpOnly, Secure, SameSite cookies with CSRF protection and CSP after a separate end-to-end authentication migration.
- LLM prompt injection from a malicious resume remains a separate design risk. Existing structured output and validators reduce impact but are not a security proof; stronger instruction/data separation and adversarial tests are recommended.
- AI provider quotas and concurrency scheduling were explicitly deferred for a later phase.
- Vulnerability scans and full deployment penetration tests are not included. On your machine run `npm audit --omit=dev` against the actual locked dependencies, assess findings, then apply and retest vetted updates. Automated tests do not establish that all vulnerabilities are absent.

## Setup / local testing

1. Back up `resume-interview-project-optimized` first.
2. Extract the changed-files patch from **inside that project root**. Keep your actual `.env` and custom CSS.
3. Run `npm test`. Eleven previously recorded legacy failures remain; no additional failures should appear.
4. Run `npm start` and open `http://localhost:5001`.
5. Select a Java assignment PDF: it should be rejected **upon selection** without triggering AI or saving a resume.
6. Select a valid resume: it should be verified, then allow Analyze after role and skills are supplied.
7. Change a previously selected target role: the required-skill chips should empty immediately. Previous interview results must remain until a new upload is analyzed.
8. Upload the example resume and confirm its four certifications appear under Resume Details.

For deployment, set `NODE_ENV=production`, `JWT_SECRET` to a private random 32+ byte value, and configure `CORS_ALLOWED_ORIGINS` only when the frontend is on a separate trusted origin. If running behind a trusted reverse proxy, set `TRUST_PROXY_HOPS` to the verified hop count. Do not expose your Groq API key to browser JavaScript.
