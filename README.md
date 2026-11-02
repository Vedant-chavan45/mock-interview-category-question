# AI-Powered Mock Interview Platform
## Resume Processing and Category-Based Interview Preparation

This repository contains a standalone resume-processing module for an AI-powered mock interview platform. Users can create an account, upload a PDF resume, review extracted profile details and analysis, and generate interview questions tailored to the resume and target role.

The application uses a local [Ollama](https://ollama.com/) model for AI analysis and question generation. Resume analysis has a clearly labelled rule-based fallback when Ollama is unavailable. Category-based question generation requires a valid Ollama response.

## Features

- **PDF resume upload:** accepts PDF files up to 5 MB.
- **Resume extraction and parsing:** extracts text and identifies contact details, skills, projects, experience, education and certifications.
- **Resume analysis:** uses Ollama when available and labels the rule-based fallback when it is used.
- **Interview context:** builds a structured candidate profile using the parsed resume, analysis, interview type and target role.
- **Category-based questions:** generates six questions for a selected category, validates the result and returns a retryable error if generation fails. It does not silently present fallback questions as AI-generated.
- **Answer practice and evaluation:** provides a text answer field for every generated question. Ollama evaluates each answer on a 1–10 scale in 0.5-point increments and returns feedback, strengths and improvement suggestions.
- **Saved practice progress:** generated question sets, submitted answers and evaluations are stored with the owned resume in MongoDB and remain available while switching categories.
- **Authentication:** supports signup and login using bcrypt password hashing and JWT bearer tokens.
- **MongoDB persistence:** stores user accounts and owner-associated resume information.
- **Browser interface and CLI demo:** includes a web UI and a command-line resume-processing demo.

## Technology stack

| Area | Technologies |
|---|---|
| Backend | Node.js, Express.js |
| Frontend | HTML, CSS, JavaScript |
| Database | MongoDB, Mongoose |
| Authentication | bcryptjs, JSON Web Tokens (JWT) |
| AI | Ollama, Llama 3.2 by default |
| Resume processing | pdf-parse, optional Poppler `pdftotext` fallback |
| Testing | Node.js test runner |

## Requirements

- Node.js 18 or later (Node.js 20 LTS is recommended).
- A MongoDB instance and connection string.
- Ollama and the configured model for resume analysis, question generation and answer evaluation.
- Poppler's `pdftotext` command is optional; it provides a secondary PDF text-extraction path.

## Run locally

### 1. Clone and install dependencies

```bash
git clone https://github.com/Vedant-chavan45/mock-interview-category-question.git
cd mock-interview-category-question
npm install
```

### 2. Configure environment variables

On Windows PowerShell, create a local environment file only if one does not already exist:

```powershell
Copy-Item .env.example .env
```

Do not overwrite an existing `.env` file. Open it and configure at least:

| Variable | Configuration |
|---|---|
| `MONGODB_URI` | Your MongoDB connection string |
| `MONGODB_DB_NAME` | Application database name; defaults to `mock_interview_platform` |
| `JWT_SECRET` | A unique, randomly generated secret |
| `ANSWER_EVALUATION_TIMEOUT_MS` | Maximum time for evaluating one answer; defaults to 120000 ms |
| `DEMO_USER_EMAIL` | Email for the initial demo account |
| `DEMO_USER_PASSWORD` | A strong, unique demo password |
| `DEMO_USER_NAME` | Display name for the initial demo account |

Generate a random JWT secret with Node.js:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Keep `DEMO_USER_ID=000000000000000000000001` unchanged when preserving the existing legacy demo-resume identity. The remaining Ollama settings in `.env.example` can be kept unless your local Ollama setup uses a different URL or model.

> **Security warning:** the current source still contains development fallback values for the demo account password and JWT signing secret. Environment variables override them, but the fallback values have not yet been removed from the code. Do not expose this application to the public internet until those fallbacks are removed or made fail-closed and the deployment security items in [Security notes](#security-notes) have been addressed.

### 3. Set up Ollama

Install and start Ollama, then download the configured model:

```bash
ollama pull llama3.2:latest
```

The default Ollama URL is `http://localhost:11434`. Resume analysis can use its labelled rule-based fallback if Ollama is unavailable. The six category-based question workflows require Ollama to return a valid response.

### 4. Run tests and start the application

```bash
npm test
npm start
```

After the server starts, open [http://localhost:5001](http://localhost:5001) in your browser. The web application requires a working MongoDB connection to start.

## Demo and verification commands

| Command | Purpose |
|---|---|
| `npm test` | Run the unit and regression test suite |
| `npm run demo` | Run the CLI resume-processing demo using `test/sample_resume.pdf` |
| `node test/liveOllamaCategories.js` | Run the live Ollama generation check across the six question categories |
| `npm run test:integration` | Run MongoDB-backed integration tests |

The CLI demo can also use a different PDF:

```bash
node test/parseSample.js path/to/resume.pdf
```

The live Ollama check needs the model running locally. The integration tests need a dedicated test database. Configure `MONGODB_TEST_DB_NAME` with a name separate from the application database and containing a distinct `test` segment. You may set `MONGODB_TEST_URI` to a separate test connection string; otherwise the test runner uses `MONGODB_URI` with the configured test database name. Do not point integration tests at a production database.

The sample resume is synthetic test data. It is not intended to represent a real candidate.

## API overview

The health endpoint is public. Authentication and resume endpoints are listed below.

| Method | Endpoint | Description |
|---|---|---|
| GET | `/health` | Reports server and MongoDB connection state |
| POST | `/api/auth/signup` | Create an account |
| POST | `/api/auth/login` | Sign in and receive a JWT |
| GET | `/api/auth/me` | Return the authenticated user |
| POST | `/api/resume/upload` | Upload and process a PDF resume |
| GET | `/api/resume/:id` | Retrieve the parsed resume and analysis |
| GET | `/api/resume/:id/context` | Retrieve the structured interview context |
| GET | `/api/resume/:id/practice` | Restore generated category questions, answers and evaluations |
| GET | `/api/resume/:id/questions` | Generate the legacy mixed-question demo set |
| POST | `/api/resume/:id/questions/:category` | Generate six questions for one category |
| POST | `/api/resume/:id/questions/:category/:questionIndex/evaluate` | Evaluate one text answer using Ollama and save the result |

Resume endpoints require an `Authorization: Bearer <token>` header. The category parameter accepts one of the six category IDs defined in `src/services/questionCategories.js`.

Available category IDs:

- `domain_fundamentals`
- `technical_concepts`
- `project_deep_dive`
- `professional_experience`
- `applied_scenarios`
- `behavioral_collaboration`

## Answer practice and AI evaluation

After generating a category's six questions, each question displays its own text-answer field and **Evaluate answer** action. Submit answers individually; the application sends the selected question, the answer and relevant non-contact resume context to the configured local Ollama model.

Each successful evaluation displays:

- A score from **1.0 to 10.0**, in **0.5-point increments** (for example, 7.5/10).
- Written feedback explaining the score.
- Specific strengths in the response.
- Actionable points to improve.

The evaluator considers correctness, relevance, reasoning, completeness, clarity and practical application, with criteria adapted to the question category. It is instructed not to reward length alone or assume experience that the candidate has not described. The server validates the returned score and feedback before showing them; malformed or out-of-range model output is rejected rather than displayed as a valid evaluation.

Answers and evaluations are saved in the resume's MongoDB practice data. Switching between categories preserves completed work. If Ollama is temporarily unavailable, the submitted answer is still retained so it can be evaluated again later. Regenerating a category replaces that category's existing question set and its associated answers/evaluations; the browser asks for confirmation before doing so when submitted work exists.

Answers are limited to 8,000 characters. The current implementation accepts typed text; speech capture and speech-to-text are not included in this version.

The evaluation request accepts a JSON body such as:

```json
{
  "answer": "I would test the endpoint with valid and invalid inputs, verify the status codes and response body, and check authentication and boundary cases."
}
```

The response contains the submitted answer and an `evaluation` object with `score`, `feedback`, `strengths`, `improvements`, `model` and `evaluatedAt`. The score is a JSON number and can be a half point (for example, `8.5`).

## Data handling

- The uploaded PDF is processed from memory. The database stores file metadata, parsed resume fields, analysis, interview context and ownership information.
- The uploaded PDF bytes, raw extracted text and generated question sets are not persisted in the Resume document.
- Resume reads are scoped to both the resume ID and the authenticated user ID.
- User passwords are stored as bcrypt hashes, not plaintext passwords.
- The browser stores the returned JWT in `localStorage`. Sign out removes the local token and user data.

Do not upload real candidate resumes to a shared or public demo unless you have permission to process that personal information. Use synthetic resumes for demonstrations and tests.

## Project structure

```text
public/                 Browser UI, styles and client-side JavaScript
src/
  config/               MongoDB connection
  controllers/          Authentication and resume request handlers
  middleware/           JWT authentication middleware
  models/               User and Resume Mongoose models
  routes/               Express API routes
  services/             PDF extraction, parsing, context, AI and question logic
test/                   Unit tests, integration tests and synthetic fixtures
server.js               Express application entry point
.env.example            Environment-variable template
```

## Limitations

- Scanned/image-only PDFs are not supported; OCR is outside the current scope.
- The application accepts PDF uploads up to 5 MB.
- Category-specific AI question generation requires the configured Ollama model to be available.
- The web application requires MongoDB. The CLI resume-processing demo and unit tests do not require the application database.

## Security notes

This repository is intended as a development and academic project, not a production-hardened service.

Before deploying it or making it accessible from the public internet:

1. Remove the hard-coded demo password and JWT signing-secret fallbacks in the source. Make startup fail when required secrets are absent.
2. Use unique, strong values for `JWT_SECRET` and the initial demo account credentials. Never reuse example credentials.
3. Restrict the current open CORS configuration to the exact frontend origins that should access the API.
4. Add rate limiting and abuse protection to signup, login and upload endpoints.
5. Use HTTPS, secure deployment secrets and a protected MongoDB network configuration.
6. Keep `.env`, database credentials, real resumes, generated user data and local backups out of Git.

The repository's `.gitignore` excludes `.env`, dependency folders and selected local resume files. Check `git status` before committing new files; a `.gitignore` rule does not remove a file that was already committed.

---

For setup or debugging, check the environment values first, then run the relevant test or demo command above. Do not share database connection strings, JWT secrets, passwords or real resume contents in issues or screenshots.
