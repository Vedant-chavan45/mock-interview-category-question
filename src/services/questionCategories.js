'use strict';

const QUESTION_COUNT_PER_CATEGORY = 6;

// Short interviewer-style examples guide the model toward practical, spoken
// questions. They are examples only; the model must still tailor wording to
// the candidate's actual evidence and the slot objective.
const QUESTION_EXAMPLES = Object.freeze({
  // Role and domain fundamentals
  api_lifecycle: 'A user reports an API error. What would you check first?',
  data_consistency: 'Two users update the same record. How would you avoid losing a change?',
  authentication_security: 'How would you check that users can only see their own information?',
  performance_scalability: 'Suppose the API slows down during busy hours. What would you check first?',
  reliability_concurrency: 'Two updates happen at once and one fails. How would you handle it?',
  architecture_tradeoffs: 'How would you decide where a new feature belongs in the app?',
  client_server_boundaries: 'A form submits but nothing is saved. Where would you look first?',
  data_flow: 'A page shows new data but the saved record is old. How would you trace it?',
  performance_accessibility: 'How would you make a page load faster without losing keyboard access?',
  reliability_debugging: 'A page shows an error after an API call. How would you trace it?',
  memory_ownership: 'A program uses memory after it is released. What would you check?',
  concurrency_synchronization: 'Two threads change the same value. How would you prevent a conflict?',
  operating_system_resources: 'A program cannot open a file. What would you check first?',
  algorithmic_performance: 'A program slows down as its input grows. How would you find the cause?',
  reliability_failure_modes: 'A program stops working after running for a while. How would you investigate?',
  systems_tradeoffs: 'How would you choose between a faster design and one easier to maintain?',
  test_strategy: 'A small change is ready. What would you test before release?',
  test_data_edges: 'A form works with normal data but fails with blanks. What else would you test?',
  automation_reliability: 'An automated test fails only sometimes. How would you investigate it?',
  api_contracts: 'An API returns the wrong status for bad input. How would you check it?',
  regression_isolation: 'A bug appears after a change. How would you reproduce it?',
  release_quality_tradeoffs: 'Time is short before release. Which checks would you run first?',
  data_quality: 'A training dataset has missing labels. What would you check before training?',
  model_selection: 'Two models give different results. How would you choose between them?',
  evaluation: 'A model score drops on new data. How would you check the result?',
  performance_resources: 'Predictions take too long. What would you measure first?',
  reproducibility: 'The same experiment gives different results. What would you compare?',
  deployment_tradeoffs: 'How would you release a model and check that it keeps working?',
  schema_modelling: 'A report needs data from two related tables. How would you model them?',
  query_correctness: 'A report shows duplicate rows. How would you check the query?',
  transactions_consistency: 'Two users update the same record. How would you avoid losing a change?',
  query_performance: 'A database query becomes slow. What would you check first?',
  data_quality_reliability: 'A data pipeline stops on a bad record. How would you find the cause?',
  storage_tradeoffs: 'What would you consider when choosing storage for a new feature?',
  component_boundaries: 'A page is hard to change. How would you split its components?',
  state_data_flow: 'A page shows old data after a save. Where would you look first?',
  accessibility_interaction: 'A user cannot reach a button with the keyboard. What would you check?',
  render_performance: 'A page becomes slow as it displays more records. What would you check?',
  client_security_reliability: 'A form accepts unsafe input. How would you validate it?',
  frontend_tradeoffs: 'A page is hard to maintain. How would you simplify its design?',
  system_boundaries: 'Which part of an application should handle user authentication?',
  data_correctness: 'A saved record contains the wrong value. How would you find the cause?',
  security_controls: 'A user can access a page they should not see. What would you check?',
  performance_constraints: 'An application slows down during busy hours. What would you check first?',
  failure_recovery: 'A feature stops working. How would you find the cause?',
  engineering_tradeoffs: 'How would you choose between two ways of building a feature?',

  // Project deep dive
  project_purpose_architecture: 'What problem was this project built to solve?',
  individual_contribution: 'Tell me about your role in building this project.',
  component_data_flow: 'What happens after a user sends a request to this project?',
  implementation_tradeoffs: 'Why did you choose this approach for this project?',
  debugging_testing: 'How did you test this project for errors?',
  limitations_improvements: 'What would you improve first if you worked on this project again?',

  // Professional experience
  responsibilities_ownership: 'Tell me about a task you handled in this role.',
  technical_contribution: 'Can you explain how you investigated a technical issue in this role?',
  challenge_investigation: 'Tell me about a real problem you faced at work and how you found the cause.',
  collaboration_coordination: 'Tell me about a time you coordinated work with other people.',
  testing_outcome_verification: 'How did you check that your changes worked as expected?',
  learning_growth: 'What did you learn from that work?',

  // Applied scenarios: each example starts with a concrete hypothetical situation.
  api_latency: 'Suppose your API becomes slow during busy hours. What would you check first?',
  database_performance: 'Suppose a database query returns the wrong records. How would you find the cause?',
  access_control_failure: 'Suppose a user can access an API endpoint they should not. What would you check first?',
  concurrent_updates: 'If two users update the same record, how would you prevent one change being lost?',
  integration_failure: 'Imagine a service stops working after an API change. How would you find the cause?',
  incident_recovery: 'Suppose a backend service stops responding. What would you check first?',
  client_api_mismatch: 'Suppose a user submits a form but the page never shows the API result. What would you check?',
  stale_interface_state: 'Imagine a page still shows old data after a successful save. Where would you look first?',
  render_performance: 'Suppose a page becomes slow when it displays more records. What would you check?',
  release_recovery: 'If a new release causes errors for users, how would you limit the impact?',
  resource_exhaustion: 'Suppose your program starts running out of memory. What would you check first?',
  concurrent_access: 'If two threads change the same value at once, how would you prevent a race?',
  operating_system_failure: 'Suppose a program can no longer open a file. What would you inspect?',
  performance_regression: 'If a program slows down after a code change, how would you find the cause?',
  safe_recovery: 'Suppose a process crashes while holding a resource. How would you recover safely?',
  regression_triage: 'If a bug appears after a release, how would you reproduce it?',
  flaky_automation: 'Suppose an automated test fails only sometimes. What would you check first?',
  api_contract_failure: 'If an API returns the wrong status code, how would you investigate it?',
  edge_case_gap: 'Suppose a form fails only when a field is blank. What test would you add?',
  environment_integration: 'If a test passes locally but fails in CI, how would you find the difference?',
  release_verification: 'Suppose a release is due soon and time is short. Which checks would you run first?',
  training_data_quality: 'Suppose a training dataset has missing labels. How would you check it before training?',
  model_generalization: 'If a model works on training data but poorly on new data, what would you check?',
  model_evaluation: 'Suppose a model score suddenly drops. How would you check whether the result is real?',
  inference_performance: 'If predictions start taking too long, what would you measure first?',
  experiment_reproducibility: 'Suppose the same experiment gives different results. What would you compare?',
  model_deployment_reliability: 'If a model behaves differently after release, how would you investigate?',
  pipeline_data_quality: 'Suppose a data pipeline receives incomplete records. Where would you look first?',
  query_results: 'If a report shows duplicate rows, how would you check the query?',
  slow_query: 'Suppose a query slows down as a table grows. What would you inspect?',
  concurrent_data_updates: 'If two jobs update the same record, how would you prevent data loss?',
  source_format_change: 'Imagine the source system changes its data format. How would you keep the pipeline working?',
  pipeline_recovery: 'Suppose a pipeline stops halfway through. How would you restart it safely?',
  service_performance: 'If the application slows down during busy hours, what would you check first?',
  concurrent_changes: 'Suppose two people update the same information. How would you prevent one change being lost?',

  // Behavioral and collaboration
  ownership_accountability: 'Tell me about a time you took responsibility for a task and finished it.',
  feedback_action: 'Can you explain how you handled feedback on your work?',
  disagreement_handling: 'Tell me about a disagreement and how you handled it.',
  team_collaboration: 'If a teammate is falling behind, how would you work with them to keep the task moving?',
  mistake_learning: 'Tell me about a bug or mistake you handled and what you learned.',
  communication_prioritization: 'If a teammate was not contributing to a shared task, how would you discuss priorities?',
});

// Slot objectives are natural-language guidance for the model. No regex intent
// is attached to a slot or used to accept/reject generated question wording.
const slot = (id, objective) => Object.freeze({
  id, objective,
  ...(QUESTION_EXAMPLES[id] ? { questionExample: QUESTION_EXAMPLES[id].replace(/[.!]$/, '?') } : {}),
});
const freezeSlots = (slots) => Object.freeze(slots);

const FUNDAMENTALS = Object.freeze({
  backend: freezeSlots([
    slot('api_lifecycle', 'Following a request through an API and deciding what should happen when the input is missing or incorrect.'),
    slot('data_consistency', 'Keeping database records correct when two updates happen at the same time or a save fails.'),
    slot('authentication_security', 'Checking that a user can access only the routes and information they are allowed to see.'),
    slot('performance_scalability', 'Finding why an API becomes slow when more people start using it.'),
    slot('reliability_concurrency', 'Handling errors and requests that try to change the same record at the same time.'),
    slot('architecture_tradeoffs', 'Choosing how to organize a feature and explaining why that approach makes sense.'),
  ]),
  fullstack: freezeSlots([
    slot('client_server_boundaries', 'Following a user action from the browser to the API and deciding which part should handle it.'),
    slot('data_flow', 'Following data from the screen to the API and database without losing changes.'),
    slot('authentication_security', 'Authentication, authorization, and protecting user-facing and server-side actions.'),
    slot('performance_accessibility', 'Making a page respond quickly while keeping it easy for everyone to use.'),
    slot('reliability_debugging', 'Finding the cause when a problem appears between the browser and the server.'),
    slot('architecture_tradeoffs', 'Architecture boundaries and trade-offs across a full-stack application.'),
  ]),
  systems: freezeSlots([
    slot('memory_ownership', 'Managing memory safely and making sure a resource is released when it is no longer needed.'),
    slot('concurrency_synchronization', 'Handling work that happens at the same time without one task interfering with another.'),
    slot('operating_system_resources', 'Finding which operating-system resource a program is using and why it is running out.'),
    slot('algorithmic_performance', 'Choosing an approach that works quickly without using too much memory.'),
    slot('reliability_failure_modes', 'Finding why a program stops working and how to recover it safely.'),
    slot('systems_tradeoffs', 'Choosing a safe and practical way to organize a systems component.'),
  ]),
  qa: freezeSlots([
    slot('test_strategy', 'Deciding what to test before a change is released.'),
    slot('test_data_edges', 'Choosing test data that helps find mistakes and unusual cases.'),
    slot('automation_reliability', 'Keeping automated tests reliable and finding why a test sometimes fails.'),
    slot('api_contracts', 'Checking that an API returns the right result for both valid and invalid requests.'),
    slot('regression_isolation', 'Finding what changed when something that used to work starts failing.'),
    slot('release_quality_tradeoffs', 'Deciding what must be checked before a change can be safely released.'),
  ]),
  'ai-ml': freezeSlots([
    slot('data_quality', 'Checking that model training data is correct and does not include misleading information.'),
    slot('model_selection', 'Choosing a model that suits the problem and the information available.'),
    slot('evaluation', 'Checking whether a model works well on data it has not seen before.'),
    slot('performance_resources', 'Finding why a model takes too long or uses too much memory.'),
    slot('reproducibility', 'Making experiments repeatable and finding why a result changes unexpectedly.'),
    slot('deployment_tradeoffs', 'Putting a model into use and checking that it continues to work as expected.'),
  ]),
  data: freezeSlots([
    slot('schema_modelling', 'Choosing how to organize stored information and how records relate to one another.'),
    slot('query_correctness', 'Making sure a query returns the right records, including when data is missing or repeated.'),
    slot('transactions_consistency', 'Keeping saved data correct when more than one update happens.'),
    slot('query_performance', 'Finding why a database query is slow and what could make it faster.'),
    slot('data_quality_reliability', 'Checking incoming data and handling a data-processing step that fails.'),
    slot('storage_tradeoffs', 'Choosing where data should be stored and how it should be changed.'),
  ]),
  frontend: freezeSlots([
    slot('component_boundaries', 'Deciding what each part of a user interface should do.'),
    slot('state_data_flow', 'Keeping screen data in the right place when a user changes something.'),
    slot('accessibility_interaction', 'Making sure people can use the interface with a keyboard or assistive technology.'),
    slot('render_performance', 'Finding why a page takes too long to update or respond.'),
    slot('client_security_reliability', 'Checking user input and showing a clear message when something goes wrong.'),
    slot('frontend_tradeoffs', 'Choosing a simple way to organize a user interface as it grows.'),
  ]),
  generic: freezeSlots([
    slot('system_boundaries', 'Deciding which part of an application should handle each task.'),
    slot('data_correctness', 'Keeping information correct when it is added, changed, or removed.'),
    slot('security_controls', 'Checking who can access information and whether incoming data is safe to use.'),
    slot('performance_constraints', 'Finding what to check when an application becomes slow.'),
    slot('failure_recovery', 'Finding what went wrong when a feature stops working and checking the fix.'),
    slot('engineering_tradeoffs', 'Choosing between two ways of building a feature and explaining your choice.'),
  ]),
});

const APPLIED_SCENARIOS = Object.freeze({
  backend: freezeSlots([
    slot('api_latency', 'An API becomes slow when more people use it; find what is causing the delay.'),
    slot('database_performance', 'A database query becomes slow or returns the wrong records; find out why.'),
    slot('access_control_failure', 'A user can open information they should not see; check how access is being controlled.'),
    slot('concurrent_updates', 'Two users update the same record at the same time; prevent a change from being lost.'),
    slot('integration_failure', 'A service integration begins failing after a change; isolate the fault and limit its impact.'),
    slot('incident_recovery', 'A backend feature stops responding; find out what happened and restore it.'),
  ]),
  fullstack: freezeSlots([
    slot('client_api_mismatch', 'A user action produces an unexpected API response; trace the client-server contract.'),
    slot('stale_interface_state', 'The interface displays stale or conflicting state after an update; isolate the data-flow issue.'),
    slot('access_control_failure', 'A user can reach an action they should not access; investigate checks across client and server.'),
    slot('render_performance', 'A page becomes slow as data grows; investigate rendering and request costs.'),
    slot('integration_failure', 'A frontend integration fails after an API change; isolate and verify the contract.'),
    slot('release_recovery', 'A deployed full-stack change causes errors; contain impact and verify recovery.'),
  ]),
  systems: freezeSlots([
    slot('resource_exhaustion', 'A systems process approaches a memory or file-resource limit; find the cause and contain it.'),
    slot('concurrent_access', 'Concurrent threads corrupt shared state; investigate synchronization and data races.'),
    slot('operating_system_failure', 'A system call or process interaction behaves unexpectedly; isolate the operating-system boundary.'),
    slot('performance_regression', 'A systems component regresses in runtime or memory use; compare behavior and identify a bottleneck.'),
    slot('integration_failure', 'A systems component fails when integrated with another module; isolate the interface failure.'),
    slot('safe_recovery', 'A process crashes or leaves resources in an uncertain state; design and verify safe recovery.'),
  ]),
  qa: freezeSlots([
    slot('regression_triage', 'A release introduces a user-visible regression; reproduce and prioritize the failure.'),
    slot('flaky_automation', 'An automated test fails intermittently; isolate nondeterminism and verify stability.'),
    slot('api_contract_failure', 'An API response violates an expected contract; identify coverage and evidence for the defect.'),
    slot('edge_case_gap', 'A boundary input exposes an untested behavior; design cases that make the defect reproducible.'),
    slot('environment_integration', 'A test passes locally but fails in an integrated environment; isolate environmental causes.'),
    slot('release_verification', 'A fix is ready near a release deadline; balance verification, risk, and coverage.'),
  ]),
  'ai-ml': freezeSlots([
    slot('training_data_quality', 'A training dataset has missing or incorrect labels; check the data before training.'),
    slot('model_generalization', 'A model performs well on training data but poorly on new examples.'),
    slot('model_evaluation', 'A model score changes; check whether the evaluation method and metric are suitable.'),
    slot('inference_performance', 'A model takes too long to return a prediction; find the main source of delay.'),
    slot('experiment_reproducibility', 'The same experiment gives different results; compare the inputs and settings.'),
    slot('model_deployment_reliability', 'A model behaves differently after release; investigate the change and verify predictions.'),
  ]),
  data: freezeSlots([
    slot('pipeline_data_quality', 'A pipeline receives incomplete or unexpected records; find where the data first becomes invalid.'),
    slot('query_results', 'A report returns the wrong rows or totals; find whether the data or query is at fault.'),
    slot('slow_query', 'A query slows down as a table grows; find what changed and test an improvement.'),
    slot('concurrent_data_updates', 'Two jobs update the same records; keep the final data correct.'),
    slot('source_format_change', 'An upstream source changes its data format; prevent the pipeline from breaking.'),
    slot('pipeline_recovery', 'A pipeline stops partway through; restart it without creating duplicate records.'),
  ]),
  generic: freezeSlots([
    slot('service_performance', 'An application becomes slow when more people use it; find what is causing the delay.'),
    slot('data_correctness', 'An update saves the wrong information; find the cause and prevent it happening again.'),
    slot('access_control_failure', 'A user can see a page they should not access; find and fix the permission check.'),
    slot('concurrent_changes', 'Two people change the same information at once; make sure neither change is lost.'),
    slot('integration_failure', 'A change breaks one part of an application that depends on another; find the cause.'),
    slot('incident_recovery', 'An important feature stops responding; restore it and check that it works properly.'),
  ]),
});

const COMMON_FUNDAMENTALS = FUNDAMENTALS.generic;
const COMMON_APPLIED = APPLIED_SCENARIOS.generic;

const categories = Object.freeze({
  domain_fundamentals: Object.freeze({
    id: 'domain_fundamentals', label: 'Role & Domain Fundamentals',
    description: 'Check how the candidate would handle common situations in the target role.',
    legacyType: 'technical',
    instruction: 'Ask practical questions about everyday decisions in this role. Do not ask for textbook definitions or claim the candidate has done something that is not in the resume.',
    slots: COMMON_FUNDAMENTALS,
    roleSlots: FUNDAMENTALS,
  }),
  technical_concepts: Object.freeze({
    id: 'technical_concepts', label: 'Technical Skills & Concepts',
    description: 'Assess the employer-required skills, whether or not they appear in the resume.',
    legacyType: 'technical',
    instruction: 'Assess the dynamically planned subtopic and objective for each technical target. Employer-required skills take priority and are never evidence of candidate experience. When no employer-required skills are selected, label the assessment as resume-skill or role-based fallback.',
    slots: freezeSlots([
      slot('technical_assessment_1', 'Assess the first independently planned technical subtopic.'),
      slot('technical_assessment_2', 'Assess the second independently planned technical subtopic.'),
      slot('technical_assessment_3', 'Assess the third independently planned technical subtopic.'),
      slot('technical_assessment_4', 'Assess the fourth independently planned technical subtopic.'),
      slot('technical_assessment_5', 'Assess the fifth independently planned technical subtopic.'),
      slot('technical_assessment_6', 'Assess the sixth independently planned technical subtopic.'),
    ]),
  }),
  project_deep_dive: Object.freeze({
    id: 'project_deep_dive', label: 'Project Deep Dive',
    description: 'Explore project architecture, tech stack rationale, end-to-end flow, implementation and design trade-offs.',
    legacyType: 'project',
    instruction: 'Prioritize architecture, modules, technical stack and why it was chosen, data flow, real implementation decisions, integration and edge cases. Only one or two questions may cover broad ownership or improvement. Use actual project titles and documented technologies; when details are absent, ask the candidate to explain rather than assert they exist. Do not invent features or outcomes.',
    slots: freezeSlots([
      slot('project_purpose_architecture', 'What problem the project was built to solve and how its main parts fit together.'),
      slot('individual_contribution', 'Which part of the project the candidate personally worked on or what role they played in building it.'),
      slot('component_data_flow', 'What happens in the project when a user takes an action or sends a request.'),
      slot('implementation_tradeoffs', 'Why the candidate chose one approach for the project instead of another.'),
      slot('debugging_testing', 'How the candidate tested the project and checked what happened when something went wrong.'),
      slot('limitations_improvements', 'What the candidate would improve if they worked on the project again.'),
    ]),
  }),
  professional_experience: Object.freeze({
    id: 'professional_experience', label: 'Professional Experience',
    description: 'Discuss real tasks, contributions, teamwork and learning from work or practical projects.',
    legacyType: 'experience',
    instruction: 'Ask about real work, internship, or practical project experience shown in the resume. If there is no formal job, ask about project work and do not call it employment. Do not assume achievements, employers or events.',
    slots: freezeSlots([
      slot('responsibilities_ownership', 'A task or responsibility the candidate personally handled.'),
      slot('technical_contribution', 'A real technical task the candidate worked on and how they approached or investigated it.'),
      slot('challenge_investigation', 'A documented work responsibility, inviting an actual challenge if one arose, without presuming a specific incident.'),
      slot('collaboration_coordination', 'Working with teammates or other people to finish a task.'),
      slot('testing_outcome_verification', 'How the candidate checked that a change worked as expected.'),
      slot('learning_growth', 'Something the candidate learned from work and what they changed afterward.'),
    ]),
  }),
  applied_scenarios: Object.freeze({
    id: 'applied_scenarios', label: 'Applied Technical Scenarios',
    description: 'See how the candidate would respond to common problems that can happen at work.',
    legacyType: 'technical',
    instruction: 'Describe an ordinary, believable work problem and ask what the candidate would check or do. Wording is flexible: a direct scenario or an opening such as If, Suppose, or Imagine is fine. Use plain English and supported technologies where useful. Never imply the candidate has experienced it.',
    slots: COMMON_APPLIED,
    roleSlots: APPLIED_SCENARIOS,
  }),
  behavioral_collaboration: Object.freeze({
    id: 'behavioral_collaboration', label: 'Behavioral & Collaboration',
    description: 'Explore how the candidate works with others, takes responsibility, handles feedback and learns.',
    legacyType: 'behavioral',
    instruction: 'Explore ownership, teamwork, communication, feedback, disagreement, accountability, prioritization, and learning. Questions may ask about a real example or a realistic hypothetical people-focused situation. Keep the wording natural and conversational; do not claim an invented event actually happened to the candidate.',
    slots: freezeSlots([
      slot('ownership_accountability', 'A real example of taking ownership and following through on a responsibility.'),
      slot('feedback_action', 'How the candidate would seek and apply feedback, inviting a real example if available.'),
      slot('disagreement_handling', 'How the candidate would respectfully handle differing opinions; request a real example only if one exists.'),
      slot('team_collaboration', 'A concrete example of collaborating with others toward shared work.'),
      slot('mistake_learning', 'How the candidate takes responsibility, learns from setbacks or would respond to an error; do not presume a real mistake.'),
      slot('communication_prioritization', 'A situation requiring clear communication and prioritization under constraints.'),
    ]),
  }),
});

function getQuestionCategory(id) {
  return typeof id === 'string' && Object.hasOwn(categories, id) ? categories[id] : null;
}

function getCategorySlots(category, roleProfile = 'generic') {
  return category?.roleSlots?.[roleProfile] || category?.slots || [];
}

module.exports = { QUESTION_COUNT_PER_CATEGORY, QUESTION_CATEGORIES: categories, getQuestionCategory, getCategorySlots };
