'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
const app = fs.readFileSync(path.join(__dirname, '../public/js/app.js'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, '../public/css/app.css'), 'utf8');
const baseCss = fs.readFileSync(path.join(__dirname, '../public/css/base.css'), 'utf8');

test('analysis tabs remain Overview and Resume Details only', () => {
  const tablist = html.match(/<div id="tabs"[\s\S]*?<\/div>/)?.[0] || '';
  assert.match(tablist, /id="tabOverview"/);
  assert.match(tablist, /id="tabDetails"/);
  assert.equal((tablist.match(/role="tab"/g) || []).length, 2);
  assert.doesNotMatch(html, /tabQuestions/);
  assert.match(css, /\.tabs\s*\{[^}]*repeat\(2,\s*minmax\(0,\s*1fr\)\)/);
});

test('Overview preparation navigates to Step 3 without making a generation request', () => {
  assert.match(html, /id="prepareQuestions"[^>]*>Prepare interview questions<\/button>/);
  const handler = app.match(/\$\('prepareQuestions'\)\.addEventListener\('click', \(\) => \{([\s\S]*?)\}\);/)?.[1] || '';
  assert.match(handler, /categoryWorkflowEntered = true/);
  assert.match(handler, /setStep\(2\)/);
  assert.doesNotMatch(handler, /fetch\(/);
  assert.match(app, /stepQuestions'\)\.disabled = !state\.current \|\| !state\.categoryWorkflowEntered/);
});

test('Step 3 uses one category navigator and selected-category workspace with live preparation progress', () => {
  assert.match(html, /id="preparedCount"/);
  assert.match(html, /id="preparedProgress"[^>]*role="progressbar"/);
  assert.match(html, /id="categoryChecklist"/);
  assert.match(html, /id="selectedCategoryPanel"/);
  assert.doesNotMatch(html, /categoryCards|category-grid|category-card/);
  assert.match(app, /state\.categoryQuestions\[category\.id\]/);
  assert.match(app, /let preparedCount = 0/);
  assert.match(app, /if \(ready\) preparedCount \+= 1/);
  assert.match(app, /preparedCount \/ questionCategories\.length \* 100/);
  assert.match(app, /'Questions ready'/);
  assert.match(app, /'Not started'/);
  assert.match(css, /\.category-workspace\s*\{[^}]*minmax\(240px,\s*\.36fr\)\s+minmax\(0,\s*1fr\)/);
  assert.match(css, /@media \(max-width: 700px\)\s*\{\s*\.category-workspace\s*\{\s*grid-template-columns:\s*minmax\(0,\s*1fr\)/);
});

test('category navigator contains the six supported categories in order', () => {
  const categories = [
    ['domain_fundamentals', 'Role & Domain Fundamentals'],
    ['technical_concepts', 'Technical Skills & Concepts'],
    ['project_deep_dive', 'Project Deep Dive'],
    ['professional_experience', 'Professional Experience'],
    ['applied_scenarios', 'Applied Technical Scenarios'],
    ['behavioral_collaboration', 'Behavioral & Collaboration'],
  ];
  let previous = -1;
  for (const [id, label] of categories) {
    const index = app.indexOf(`id: '${id}'`);
    assert.ok(index > previous, `Missing or out-of-order category ${id}`);
    assert.ok(app.indexOf(`label: '${label}'`, index) > index, `Missing label for ${id}`);
    previous = index;
  }
  assert.match(app, /checklist\.append\(row\)/);
  assert.match(app, /select\.setAttribute\('aria-current', String\(isSelected\)\)/);
  assert.match(app, /select\.addEventListener\('click', \(\) => selectCategory\(category\.id, true\)\)/);
});

test('category switching renders only that category set and does not discard other sets', () => {
  const selector = app.match(/function\s+selectCategory\b[\s\S]*?(?=function\s+renderCategoryInterface\b)/)?.[0] || '';
  assert.ok(selector, 'Expected category selection handler');
  assert.match(selector, /state\.selectedCategory = categoryId/);
  assert.match(selector, /renderCategoryInterface\(\)/);
  assert.doesNotMatch(selector, /state\.categoryQuestions\s*=/, 'Selecting a category must not replace generated sets');
  assert.doesNotMatch(selector, /fetch\(|generateCategory\(/);
  assert.match(app, /const record = selected && state\.categoryQuestions\[selected\.id\]/);
  assert.match(app, /categoryQuestionList'\)\.replaceChildren\(\)/);
  assert.match(app, /record\.questions\.forEach\(\(question, index\) =>/);
  assert.match(app, /renderQuestionPractice\(item, question, index, selected\.id\)/);
  assert.match(app, /state\.categoryQuestions = Object\.create\(null\)/);
  assert.match(app, /state\.categoryQuestions\[categoryId\] =/);
});

test('the selected workspace has one explicit generate or regenerate action using the existing category endpoint', () => {
  assert.match(html, /id="generateCategoryButton"[^>]*class="btn btn-primary"/);
  assert.match(app, /generateCategoryButton'\)\.addEventListener\('click', \(\) => generateCategory\(state\.selectedCategory\)\)/);
  assert.equal((app.match(/\$\('generateCategoryButton'\)\.addEventListener\('click'/g) || []).length, 1);
  assert.match(app, /questions\/\$\{encodeURIComponent\(categoryId\)\}`,[\s\S]*?method: 'POST'/);
  assert.match(app, /if \(!state\.current \|\| state\.categoryBusy/);
  assert.match(app, /state\.categoryBusy = categoryId/);
  assert.match(app, /state\.categoryErrors\[selected\?\.id\] \? 'Retry generation' : hasQuestions \? 'Regenerate Questions' : 'Generate 6 Questions'/);
  assert.match(app, /body\.append\('targetRole', snapshot\.targetRole\)[\s\S]*?body\.append\('interviewType', snapshot\.interviewType\)/);
  assert.match(app, /if \(isCurrent\(\)\) \{ state\.categoryBusy = ''; syncControls\(\); \}/);
  assert.equal((app.match(/fetch\(`\/api\/resume\/\$\{encodeURIComponent\(resumeId\)\}\/questions\/\$\{encodeURIComponent\(categoryId\)\}`/g) || []).length, 1);
  assert.doesNotMatch(app, /fetch\(`\/api\/resume\/\$\{encodeURIComponent\(resumeId\)\}\/questions`/);
});

test('category source is honest and failed regeneration retains the previous set', () => {
  assert.match(app, /source\(\$\('categorySource'\), record\.source\)/);
  assert.match(app, /heuristic-fallback/);
  assert.match(app, /else if \(hasQuestions\)[\s\S]*?Questions ready/);
  assert.match(app, /Regeneration failed; existing set kept/);
  const generator = app.match(/async function generateCategory\([\s\S]*?(?=function selectTab\b)/)?.[0] || '';
  assert.ok(generator, 'Expected existing category generation handler');
  assert.match(generator, /state\.categoryQuestions\[categoryId\] = \{ questions: data\.questions, source: data\.source, model: data\.model/);
  assert.doesNotMatch(generator, /delete state\.categoryQuestions\[categoryId\]/);
  assert.match(generator, /state\.categoryErrors\[categoryId\] = error\.message/);
  const sourceRenderer = app.match(/function source\([\s\S]*?(?=function detailsSection\b)/)?.[0] || '';
  assert.match(sourceRenderer, /ollama\|groq/); // recognize both real provider labels
  assert.match(sourceRenderer, /sourceValue === 'heuristic-fallback'/);
  assert.doesNotMatch(sourceRenderer, /sourceValue\.startsWith\('ollama'\)/);
  assert.match(generator, /data\.source !== `ollama-\$\{data\.model\}`/);
  assert.match(generator, /data\.source !== `groq-\$\{data\.model\}`/);
  assert.match(generator, /data\.questions\.length !== 6/);
  assert.match(app, /Insufficient resume evidence/);
  assert.match(generator, /state\.categoryInsufficient\[categoryId\] = data\.error/);
});

test('category workspace styles are scoped and leave shared panel/login layout rules untouched', () => {
  assert.match(css, /\.category-navigator/);
  assert.match(css, /\.selected-category/);
  assert.match(css, /\.category-workspace-status/);
  assert.match(css, /\.access-panel\s*\{[^}]*max-width: 640px/);
  assert.match(baseCss, /\.panel\s*\{[^}]*min-width: 0/);
  assert.doesNotMatch(css, /(?:^|,)\s*\.panel\s*\{/);
});

test('static and generated category selection IDs remain unique', () => {
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
  assert.equal(new Set(ids).size, ids.length, 'Static page IDs must be unique');
  assert.match(app, /select\.id = `select-category-\$\{category\.id\}`/);
  assert.match(app, /id: 'domain_fundamentals'[\s\S]*?id: 'behavioral_collaboration'/);
});

test('Back to Analysis preserves session state and returns through existing workflow navigation', () => {
  assert.match(html, /id="backToAnalysis"[^>]*>Back to Analysis<\/button>/);
  assert.match(app, /\$\('backToAnalysis'\)\.addEventListener\('click', \(\) => \{ selectTab\(0\); focusSection\(\$\('resultsTitle'\)\); \}\)/);
});

test('Resume Workspace summary hides only in Step 3 and returns when navigating back to Analysis', () => {
  const summary = html.match(/<div id="resumeWorkspaceSummary"[\s\S]*?<\/div>/)?.[0] || '';
  assert.ok(summary, 'Expected dedicated Resume Workspace summary container');
  assert.match(summary, /id="resultsTitle"/);
  assert.match(summary, /id="resultsContext"/);
  assert.match(summary, /id="resultsFile"/);
  const setStepStart = app.indexOf('function setStep(');
  const setStepEnd = app.indexOf('function selectCategory(', setStepStart);
  assert.ok(setStepStart >= 0 && setStepEnd > setStepStart, 'Expected existing workflow step navigation');
  const navigation = app.slice(setStepStart, setStepEnd);
  assert.match(navigation, /const inQuestions = index === 2/);
  assert.match(navigation, /\$\('resumeWorkspaceSummary'\)\.hidden = inQuestions/);
  assert.match(navigation, /\$\('questionsPanel'\)\.hidden = !inQuestions/);
  assert.match(app, /function selectTab\(index, focus = false\)[\s\S]*?setStep\(1\)/);
  assert.match(app, /\$\('backToAnalysis'\)\.addEventListener\('click', \(\) => \{ selectTab\(0\)/);
});


test('each generated question renders a text answer field and an individual evaluation result', () => {
  assert.match(app, /textarea\.maxLength = 8000/);
  assert.match(app, /answerLabel\.htmlFor = fieldId/);
  assert.match(app, /Evaluate answer/);
  assert.match(app, /renderEvaluation\(answerPanel, question\.evaluation\)/);
  assert.match(app, /evaluation\.score/);
  assert.match(app, /evaluation\.feedback/);
  assert.match(app, /evaluation\.strengths/);
  assert.match(app, /evaluation\.improvements/);
});


test('an evaluating question locks its own evaluate button and exposes accessible busy state', () => {
  const renderer = app.match(/function renderQuestionPractice\([\s\S]*?(?=function renderCategoryInterface\b)/)?.[0] || '';
  assert.ok(renderer, 'Expected per-question answer renderer');
  assert.match(renderer, /answerRequests\.has\(key\)/);
  assert.match(renderer, /button\.disabled = busy \|\| !state\.authenticated/);
  assert.match(renderer, /button\.setAttribute\('aria-busy', String\(busy\)\)/);
  assert.match(renderer, /Evaluating with AI/);
  const evaluate = app.match(/async function evaluateAnswer\([\s\S]*?(?=async function loadPractice\b)/)?.[0] || '';
  assert.match(evaluate, /if \(state\.answerBusy\[key\] \|\| answerRequests\.has\(key\)\) return/);
  assert.doesNotMatch(evaluate, /answerRequests\.get\(key\)\?\.abort\(\)/);
  assert.match(css, /\.answer-evaluate-button\.is-evaluating::before/);
  assert.match(css, /prefers-reduced-motion:\s*reduce/);
});

test('answers are submitted individually and saved practice is restored for the resume', () => {
  assert.match(app, /questions\/\$\{encodeURIComponent\(categoryId\)\}\/\$\{questionIndex\}\/evaluate/);
  assert.match(app, /body: JSON\.stringify\(\{ answer \}\)/);
  assert.match(app, /question\.answer = data\.answer/);
  assert.match(app, /question\.evaluation = data\.evaluation/);
  assert.match(app, /\/practice`/);
  assert.match(app, /state\.categoryQuestions\[categoryId\] = categoryRecord/);
});

test('regenerating a category warns before replacing submitted answers and evaluations', () => {
  const generator = app.match(/async function generateCategory\([\s\S]*?(?=async function evaluateAnswer\b)/)?.[0] || '';
  assert.match(generator, /hasSubmittedWork/);
  assert.match(generator, /window\.confirm/);
  assert.match(generator, /categoryHasActiveAnswerEvaluations\(categoryId\)/);
});
