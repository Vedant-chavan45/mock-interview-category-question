(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const MAX_FILE_SIZE = 5 * 1024 * 1024;
  const state = { token: '', authenticated: false, leaving: false, file: null, current: null,
    uploadBusy: false, categoryBusy: '', categoryWorkflowEntered: false, selectedCategory: '',
    categoryQuestions: Object.create(null), categoryErrors: Object.create(null), categoryInsufficient: Object.create(null),
    answerDrafts: Object.create(null), answerBusy: Object.create(null), answerErrors: Object.create(null),
    practiceLoading: false, practiceLoadError: '', practiceLoadedFor: '',
    uploadId: 0, questionId: 0, authId: 0 };
  let authRequest, uploadRequest, questionRequest;
  const answerRequests = new Map();
  const questionCategories = [
    { id: 'domain_fundamentals', label: 'Role & Domain Fundamentals', description: 'Explore core principles and trade-offs that shape the target role and its technical domain.' },
    { id: 'technical_concepts', label: 'Technical Skills & Concepts', description: 'Assess practical understanding of the skills and technologies evidenced in the resume.' },
    { id: 'project_deep_dive', label: 'Project Deep Dive', description: 'Probe real project decisions, individual contributions, constraints and verification.' },
    { id: 'professional_experience', label: 'Professional Experience', description: 'Discuss responsibilities, delivery, challenges and outcomes from the resume.' },
    { id: 'applied_scenarios', label: 'Applied Technical Scenarios', description: 'Work through realistic hypothetical technical problems using relevant resume skills.' },
    { id: 'behavioral_collaboration', label: 'Behavioral & Collaboration', description: 'Explore communication, collaboration, feedback, ownership and learning.' },
  ];
  const tabs = ['tabOverview', 'tabDetails'].map($);
  const panels = ['overviewPanel', 'detailsPanel'].map($);
  const text = value => typeof value === 'string' || typeof value === 'number' ? String(value) : '';
  const strings = value => Array.isArray(value) ? value.filter(item => typeof item === 'string' && item.trim()) : [];
  const records = value => Array.isArray(value) ? value.filter(item => item && typeof item === 'object' && !Array.isArray(item)) : [];
  const answerKey = (categoryId, index) => `${categoryId}:${index}`;
  const categoryHasActiveAnswerEvaluations = categoryId => Object.keys(state.answerBusy).some(key => key.startsWith(`${categoryId}:`) && state.answerBusy[key]);
  // Untrusted resume/model data is rendered exclusively as text nodes.
  function node(tag, content = '', className = '') {
    const el = document.createElement(tag); el.textContent = text(content);
    if (className) el.className = className; // Class names are internal constants only.
    return el;
  }
  function status(id, message = '', kind = '') {
    const el = $(id);
    el.textContent = message;
    el.className = 'status' + ({ error: ' status-error', success: ' status-success', warning: ' status-warning' }[kind] || '');
  }
  function focusSection(el) {
    el.focus({ preventScroll: true });
    el.scrollIntoView({ block: 'start', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  }
  function headers() { return { Authorization: `Bearer ${state.token}` }; }
  function invalidateRequests() {
    state.authId++; state.uploadId++; state.questionId++;
    authRequest?.abort(); uploadRequest?.abort(); questionRequest?.abort();
    for (const request of answerRequests.values()) request.abort();
    answerRequests.clear();
  }
  function leave(message) {
    state.leaving = true; state.authenticated = false; invalidateRequests();
    $('workspace').hidden = true; $('userGreeting').textContent = '';
    try {
      localStorage.removeItem('resumeAppToken'); localStorage.removeItem('resumeAppUser');
      window.location.replace('/login.html');
    } catch {
      $('accessPanel').hidden = false; $('retryAccess').hidden = true;
      $('accessStatus').textContent = message || 'Browser storage could not be cleared. Close this page and clear browser data for this site to finish signing out.';
    }
  }
  function unauthorized(res) {
    if (res.status !== 401) return false;
    leave('Your sign-in expired. Clear browser data for this site and sign in again if storage is unavailable.');
    return true;
  }
  async function verifyAccess() {
    if (state.leaving) return;
    const id = ++state.authId;
    authRequest?.abort(); authRequest = new AbortController();
    $('retryAccess').hidden = true; $('accessPanel').hidden = false;
    $('accessStatus').textContent = 'Verifying your sign-in...';
    try {
      state.token = localStorage.getItem('resumeAppToken') || '';
      if (!state.token) { leave(); return; }
      const res = await fetch('/api/auth/me', { headers: headers(), signal: authRequest.signal });
      if (id !== state.authId || state.leaving) return;
      if (unauthorized(res)) return;
      if (!res.ok) throw new Error('verification');
      const data = await res.json();
      if (id !== state.authId || state.leaving) return;
      if (!data.user || typeof data.user.id !== 'string') throw new Error('verification');
      localStorage.setItem('resumeAppUser', JSON.stringify(data.user));
      $('userGreeting').textContent = text(data.user.name) || text(data.user.email) || 'Signed in';
      state.authenticated = true;
      $('accessPanel').hidden = true; $('workspace').hidden = false;
      syncControls();
    } catch (err) {
      if (id !== state.authId || state.leaving || err.name === 'AbortError') return;
      $('accessStatus').textContent = 'We could not verify your sign-in. Check your connection and browser storage settings, then retry. You have not been signed out.';
      $('retryAccess').hidden = false;
    }
  }
  $('retryAccess').addEventListener('click', verifyAccess);
  $('logoutBtn').addEventListener('click', () => leave());
  function syncControls() {
    $('setupFields').disabled = state.uploadBusy || !state.authenticated;
    $('submitBtn').disabled = !state.file || state.uploadBusy || !state.authenticated;
    $('submitBtn').textContent = state.uploadBusy ? 'Analyzing resume...' : 'Analyze resume';
    $('setupForm').setAttribute('aria-busy', String(state.uploadBusy));
    $('processing').hidden = !state.uploadBusy;
    $('editSetup').disabled = state.uploadBusy;
    $('prepareQuestions').disabled = !state.current || state.uploadBusy || !state.authenticated;
    $('stepAnalysis').disabled = !state.current;
    $('stepQuestions').disabled = !state.current || !state.categoryWorkflowEntered || !state.authenticated || state.uploadBusy;
    $('questionsStepHelp').hidden = state.categoryWorkflowEntered;
    $('questionsStepHelp').textContent = state.categoryWorkflowEntered ? '' : 'Locked: choose Prepare Interview Questions from Overview';
    if (state.categoryWorkflowEntered) $('stepQuestions').removeAttribute('aria-describedby');
    else $('stepQuestions').setAttribute('aria-describedby', 'questionsStepHelp');
    $('questionsStepState').textContent = state.categoryWorkflowEntered ? 'Choose a category' : 'Prepare from your results';
    renderCategoryInterface();
  }
  function setStep(index) {
    ['stepResume', 'stepAnalysis', 'stepQuestions'].forEach((id, i) => {
      if (i === index) $(id).setAttribute('aria-current', 'step'); else $(id).removeAttribute('aria-current');
    });
    const inQuestions = index === 2;
    $('resumeWorkspaceSummary').hidden = inQuestions;
    $('tabs').hidden = inQuestions;
    $('questionsStatus').hidden = inQuestions;
    $('overviewPanel').hidden = inQuestions || $('tabOverview').getAttribute('aria-selected') !== 'true';
    $('detailsPanel').hidden = inQuestions || $('tabDetails').getAttribute('aria-selected') !== 'true';
    $('questionsPanel').hidden = !inQuestions;
  }
  function selectCategory(categoryId, restoreFocus = false) {
    if (!questionCategories.some((category) => category.id === categoryId)) return;
    state.selectedCategory = categoryId;
    renderCategoryInterface();
    if (restoreFocus) $(`select-category-${categoryId}`).focus();
  }
  function isOllamaResult(record) {
    return Boolean(record && /^ollama-[a-z0-9][a-z0-9._:-]*$/i.test(record.source || '') &&
      record.model && record.source === `ollama-${record.model}` && record.status === 'ready' &&
      Array.isArray(record.questions) && record.questions.length === 6);
  }
  function renderEvaluation(parent, evaluation) {
    if (!evaluation || typeof evaluation !== 'object') return;
    const panel = node('section', '', 'answer-evaluation');
    const header = node('div', '', 'evaluation-heading');
    header.append(node('strong', 'AI evaluation', 'evaluation-title'));
    header.append(node('span', `${text(evaluation.score)}/10`, 'evaluation-score'));
    panel.append(header);
    panel.append(node('p', evaluation.feedback, 'evaluation-feedback'));
    for (const [title, values, className] of [
      ['What you did well', evaluation.strengths, 'evaluation-strengths'],
      ['What to improve', evaluation.improvements, 'evaluation-improvements'],
    ]) {
      const items = strings(values);
      if (!items.length) continue;
      const group = node('div', '', className);
      group.append(node('h5', title));
      const list = node('ul');
      items.forEach(value => list.append(node('li', value)));
      group.append(list); panel.append(group);
    }
    if (text(evaluation.model)) panel.append(node('p', `Evaluated by ${text(evaluation.model)}`, 'evaluation-model'));
    parent.append(panel);
  }

  function renderQuestionPractice(item, question, index, categoryId) {
    const key = answerKey(categoryId, index);
    const fieldId = `answer-${categoryId}-${index}`;
    // The state flag drives rendering; the request Map is an additional lock so
    // an already-running request cannot be replaced by a second click.
    const busy = Boolean(state.answerBusy[key] || answerRequests.has(key));
    const answer = Object.hasOwn(state.answerDrafts, key)
      ? state.answerDrafts[key] : text(question.answer);

    item.append(node('p', question.question, 'question-body'));
    const meta = node('div', '', 'question-meta');
    if (text(question.type)) meta.append(node('span', question.type, 'badge'));
    if (text(question.basedOn)) meta.append(node('p', `Based on: ${text(question.basedOn)}`));
    item.append(meta);

    const answerPanel = node('section', '', 'answer-panel');
    const answerLabel = node('label', 'Your answer', 'answer-label');
    answerLabel.htmlFor = fieldId;
    answerPanel.append(answerLabel);
    const textarea = document.createElement('textarea');
    textarea.id = fieldId;
    textarea.name = fieldId;
    textarea.rows = 5;
    textarea.maxLength = 8000;
    textarea.placeholder = 'Type your answer here. Explain your approach, reasoning and any relevant example…';
    textarea.value = answer;
    textarea.disabled = busy || !state.authenticated;
    textarea.setAttribute('aria-describedby', `${fieldId}-hint ${fieldId}-count`);
    textarea.addEventListener('input', () => {
      state.answerDrafts[key] = textarea.value;
      count.textContent = `${textarea.value.length.toLocaleString()} / 8,000 characters`;
    });
    answerPanel.append(textarea);

    const hint = node('p', 'Your answer is evaluated individually. You can edit it and request a new evaluation later.', 'helper');
    hint.id = `${fieldId}-hint`;
    const controls = node('div', '', 'answer-controls');
    const count = node('span', `${answer.length.toLocaleString()} / 8,000 characters`, 'answer-character-count');
    count.id = `${fieldId}-count`;
    const button = node('button', busy ? 'Evaluating with Ollama…' : question.evaluation ? 'Re-evaluate answer' : 'Evaluate answer', 'btn btn-primary answer-evaluate-button');
    button.type = 'button';
    button.disabled = busy || !state.authenticated;
    button.setAttribute('aria-busy', String(busy));
    button.setAttribute('aria-label', busy ? 'Evaluation in progress. Please wait.' :
      (question.evaluation ? 'Re-evaluate answer' : 'Evaluate answer'));
    if (busy) button.classList.add('is-evaluating');
    button.addEventListener('click', () => evaluateAnswer(categoryId, index));
    controls.append(count, button);
    answerPanel.append(hint, controls);

    const errorText = state.answerErrors[key];
    const error = node('p', errorText || '', 'answer-error');
    error.hidden = !errorText;
    error.setAttribute('role', 'alert');
    answerPanel.append(error);
    if (busy) answerPanel.append(node('p', 'Ollama is reviewing your answer against the question and interview criteria. This may take a little while.', 'answer-progress'));
    renderEvaluation(answerPanel, question.evaluation);
    item.append(answerPanel);
  }

  function renderCategoryInterface() {
    const checklist = $('categoryChecklist');
    if (!checklist) return;
    const snapshot = state.current?.snapshot;
    $('questionContext').textContent = [
      snapshot?.targetRole,
      snapshot?.interviewType && `${snapshot.interviewType} interview`,
    ].filter(Boolean).join(' · ') || 'Your current resume and interview context';
    checklist.replaceChildren();
    let preparedCount = 0;
    for (const [index, category] of questionCategories.entries()) {
      const record = state.categoryQuestions[category.id];
      const ready = isOllamaResult(record);
      if (ready) preparedCount += 1;
      const isSelected = state.selectedCategory === category.id;
      const isBusy = state.categoryBusy === category.id;
      const row = node('li', '', 'category-checklist-item' + (ready ? ' is-ready' : '') + (isSelected ? ' is-selected' : ''));
      const select = node('button', '', 'category-select');
      select.type = 'button'; select.id = `select-category-${category.id}`;
      select.setAttribute('aria-current', String(isSelected));
      select.dataset.ready = String(ready);
      const indicator = node('span', ready ? '✓' : String(index + 1), 'category-indicator');
      indicator.setAttribute('aria-hidden', 'true');
      const copy = node('span', '', 'category-copy');
      copy.append(node('span', category.label, 'category-name'));
      const evaluatedCount = ready ? record.questions.filter((question) => question.evaluation && Number.isFinite(question.evaluation.score)).length : 0;
      const readyLabel = ready ? evaluatedCount ? `${evaluatedCount}/6 evaluated` : 'Questions ready' : '';
      const rowStatus = node('span', isBusy && !ready ? 'Generating…' : readyLabel || (state.categoryInsufficient[category.id] ? 'Insufficient evidence' : state.categoryErrors[category.id] ? 'Generation failed' : 'Not started'), 'category-checklist-status' + (ready ? ' is-ready' : '') + ((state.categoryErrors[category.id] || state.categoryInsufficient[category.id]) && !ready ? ' is-error' : ''));
      copy.append(rowStatus);
      if (isBusy && ready) copy.append(node('span', 'Regenerating… Existing set available', 'category-substatus'));
      else if (state.categoryErrors[category.id] && ready) copy.append(node('span', 'Regeneration failed; existing set kept', 'category-substatus is-error'));
      select.append(indicator, copy);
      select.addEventListener('click', () => selectCategory(category.id, true));
      row.append(select);
      checklist.append(row);
    }
    const progressLabel = `${preparedCount} of ${questionCategories.length} categories prepared`;
    $('preparedCount').textContent = progressLabel;
    $('preparedProgress').setAttribute('aria-valuenow', String(preparedCount));
    $('preparedProgress').setAttribute('aria-valuetext', progressLabel);
    $('preparedProgressFill').style.width = `${preparedCount / questionCategories.length * 100}%`;

    const selected = questionCategories.find((category) => category.id === state.selectedCategory);
    const record = selected && state.categoryQuestions[selected.id];
    const selectedBusy = Boolean(selected && state.categoryBusy === selected.id);
    const anotherCategoryBusy = Boolean(state.categoryBusy && selected && state.categoryBusy !== selected.id);
    const hasQuestions = isOllamaResult(record);
    $('selectedCategoryTitle').textContent = selected?.label || 'Select a question category';
    $('selectedCategoryDescription').textContent = selected?.description || 'Choose a category to view its workspace.';
    $('categoryQuestionList').replaceChildren(); $('categorySource').replaceChildren();
    $('selectedCategoryStatus').replaceChildren();
    $('selectedCategoryStatus').className = 'category-workspace-status';
    $('selectedCategoryError').hidden = true;
    $('selectedCategoryError').textContent = '';
    const selectedAnswerBusy = Boolean(selected && categoryHasActiveAnswerEvaluations(selected.id));
    $('generateCategoryButton').disabled = !selected || !state.current || selectedBusy || Boolean(state.categoryBusy) || selectedAnswerBusy || state.practiceLoading || state.uploadBusy || !state.authenticated || Boolean(state.categoryInsufficient[selected?.id]);
    $('generateCategorySpinner').hidden = !selectedBusy;
    $('generateCategoryLabel').textContent = selectedBusy ? 'Generating…' : selectedAnswerBusy ? 'Evaluating answer…' : state.practiceLoading ? 'Loading saved work…' : anotherCategoryBusy ? 'Generation in progress' : state.categoryInsufficient[selected?.id] ? 'Insufficient resume evidence' : state.categoryErrors[selected?.id] ? 'Retry generation' : hasQuestions ? 'Regenerate Questions' : 'Generate 6 Questions';
    $('categoryActionDescription').textContent = selectedBusy
      ? 'Generating questions for this category only…'
      : selectedAnswerBusy ? 'An answer in this category is being evaluated. You can keep editing other answers after it completes.'
      : state.practiceLoading ? 'Restoring saved question sets, answers and evaluations…'
      : anotherCategoryBusy ? `Generating ${questionCategories.find((category) => category.id === state.categoryBusy)?.label || 'another category'} questions. You can continue reviewing this category.`
      : state.categoryInsufficient[selected?.id] ? 'This category needs documented project, skill, or experience evidence in the resume.'
        : state.categoryErrors[selected?.id] ? `No new question set was accepted. ${hasQuestions ? 'Your current questions remain available.' : 'Retry when ready.'}`
          : hasQuestions ? 'Generate a fresh set only when you choose. Your current questions remain until a replacement succeeds.'
          : 'Generate six questions for this category only. Your other category sets will stay available.';
    if (!selected) {
      $('selectedCategoryStatus').textContent = 'Choose a category to view or generate its questions.';
      return;
    }
    if (selectedBusy) {
      $('selectedCategoryStatus').classList.add('is-loading');
      const spinner = node('span', '', 'spinner'); spinner.setAttribute('aria-hidden', 'true');
      $('selectedCategoryStatus').append(spinner, node('span', hasQuestions ? 'Regenerating questions… Your current set remains available.' : 'Generating questions…'));
    } else if (anotherCategoryBusy) {
      const spinner = node('span', '', 'spinner'); spinner.setAttribute('aria-hidden', 'true');
      const busyName = questionCategories.find((category) => category.id === state.categoryBusy)?.label || 'another category';
      $('selectedCategoryStatus').classList.add(hasQuestions ? 'is-ready' : 'is-loading');
      $('selectedCategoryStatus').append(
        ...(hasQuestions ? [node('span', 'Questions ready.')] : []),
        spinner,
        node('span', `Generating questions for ${busyName}.`),
      );
    } else if (hasQuestions) {
      $('selectedCategoryStatus').classList.add('is-ready');
      $('selectedCategoryStatus').textContent = 'Questions ready';
    } else if (state.categoryInsufficient[selected.id]) {
      $('selectedCategoryStatus').classList.add('is-error');
      $('selectedCategoryStatus').textContent = 'Insufficient resume evidence';
    } else if (state.categoryErrors[selected.id]) {
      $('selectedCategoryStatus').classList.add('is-error');
      $('selectedCategoryStatus').textContent = 'Generation failed';
    } else if (state.practiceLoading) {
      $('selectedCategoryStatus').classList.add('is-loading');
      $('selectedCategoryStatus').textContent = 'Restoring saved practice data…';
    } else {
      $('selectedCategoryStatus').textContent = 'Not started';
    }
    if (state.practiceLoadError) {
      $('selectedCategoryError').textContent = state.practiceLoadError;
      $('selectedCategoryError').hidden = false;
    }
    if (state.categoryErrors[selected.id] || state.categoryInsufficient[selected.id]) {
      const retainedSetMessage = hasQuestions ? ' Your previous question set is still available.' : '';
      $('selectedCategoryError').textContent = `${state.categoryInsufficient[selected.id] || state.categoryErrors[selected.id]}${retainedSetMessage}`;
      $('selectedCategoryError').hidden = false;
    }
    if (hasQuestions) {
      source($('categorySource'), record.source);
      if (record.metrics) {
        const m = record.metrics;
        const details = [`Model: ${record.model}`, `request ${Math.round((m.totalDurationMs || m.requestMs || 0) / 1000)}s`];
        if (Number.isFinite(m.modelLoadMs)) details.push(`load ${m.modelLoadMs}ms`);
        if (Number.isFinite(m.promptEvalMs)) details.push(`prompt ${m.promptEvalMs}ms`);
        if (Number.isFinite(m.outputGenerationMs)) details.push(`generation ${m.outputGenerationMs}ms`);
        if (Number.isFinite(m.promptTokens) || Number.isFinite(m.outputTokens)) details.push(`${m.promptTokens ?? '?'} input / ${m.outputTokens ?? '?'} output tokens`);
        if (m.repairCount) details.push(`repaired ${m.repairCount} slot`);
        if (m.cacheHit) details.push('session cache');
        $('categorySource').append(node('p', details.join(' · '), 'helper'));
      }
      record.questions.forEach((question, index) => {
        const item = node('li', '', 'question-practice-item');
        renderQuestionPractice(item, question, index, selected.id);
        $('categoryQuestionList').append(item);
      });
    }
  }
  async function generateCategory(categoryId) {
    if (!state.current || state.categoryBusy || state.uploadBusy || !state.authenticated || state.leaving || categoryHasActiveAnswerEvaluations(categoryId)) return;
    const category = questionCategories.find((item) => item.id === categoryId);
    if (!category) return;
    const existingQuestions = state.categoryQuestions[categoryId]?.questions || [];
    const hasSubmittedWork = existingQuestions.some((question) => text(question.answer).trim() || question.evaluation);
    if (hasSubmittedWork && !window.confirm('Generating a new question set will replace the answers and evaluations for this category. Continue?')) return;
    selectCategory(categoryId);
    const resumeId = state.current.id;
    const uploadId = state.uploadId;
    const requestId = ++state.questionId;
    questionRequest?.abort(); questionRequest = new AbortController();
    const isCurrent = () => requestId === state.questionId && uploadId === state.uploadId && resumeId === state.current?.id && !state.leaving;
    state.categoryBusy = categoryId; delete state.categoryErrors[categoryId];
    syncControls();
    try {
      const response = await fetch(`/api/resume/${encodeURIComponent(resumeId)}/questions/${encodeURIComponent(categoryId)}`, {
        method: 'POST', headers: { ...headers(), ...(state.categoryQuestions[categoryId] ? { 'X-Regenerate': 'true' } : {}) }, signal: questionRequest.signal,
      });
      if (!isCurrent()) return;
      if (unauthorized(response)) return;
      const data = await response.json().catch(() => ({}));
      if (!isCurrent()) return;
      if (response.status === 422 && data.errorCode === 'insufficient-evidence') {
        state.categoryInsufficient[categoryId] = data.error || 'This resume does not contain enough documented evidence for this category.';
        delete state.categoryErrors[categoryId];
        return;
      }
      if (!response.ok || data.category !== categoryId || data.status !== 'ready' || !Array.isArray(data.questions) ||
          data.questions.length !== 6 || data.source !== `ollama-${data.model}` || !data.model) {
        throw new Error(typeof data.error === 'string' ? data.error : 'No usable questions were returned. Please retry.');
      }
      state.categoryQuestions[categoryId] = { questions: data.questions, source: data.source, model: data.model,
        metrics: data.metrics, status: data.status };
      for (let index = 0; index < 6; index += 1) {
        const key = answerKey(categoryId, index);
        delete state.answerDrafts[key]; delete state.answerErrors[key]; delete state.answerBusy[key];
      }
      delete state.categoryInsufficient[categoryId];
    } catch (error) {
      if (!isCurrent() || error.name === 'AbortError') return;
      state.categoryErrors[categoryId] = error.message || 'Unable to generate questions. Please retry.';
    } finally {
      if (isCurrent()) { state.categoryBusy = ''; syncControls(); }
    }
  }
  async function evaluateAnswer(categoryId, questionIndex) {
    const record = state.categoryQuestions[categoryId];
    const question = record?.questions?.[questionIndex];
    if (!state.current || !isOllamaResult(record) || !question || state.uploadBusy || !state.authenticated || state.leaving) return;
    const key = answerKey(categoryId, questionIndex);
    // Guard both the visible busy state and the in-flight request slot. This
    // prevents double-clicks or stale event handlers from starting a second
    // Ollama evaluation for the same question.
    if (state.answerBusy[key] || answerRequests.has(key)) return;
    const answer = Object.hasOwn(state.answerDrafts, key) ? state.answerDrafts[key] : text(question.answer);
    if (!answer.trim()) {
      state.answerErrors[key] = 'Enter your answer before requesting an evaluation.';
      renderCategoryInterface();
      $(`answer-${categoryId}-${questionIndex}`).focus();
      return;
    }
    if (answer.length > 8000) {
      state.answerErrors[key] = 'Your answer must be 8,000 characters or fewer.';
      renderCategoryInterface();
      return;
    }

    const resumeId = state.current.id;
    const uploadId = state.uploadId;
    const controller = new AbortController();
    // Never abort-and-replace an active evaluation for the same question.
    // The first request owns this slot until its finally block releases it.
    answerRequests.set(key, controller);
    state.answerBusy[key] = true;
    delete state.answerErrors[key];
    renderCategoryInterface();

    const isCurrent = () => uploadId === state.uploadId && resumeId === state.current?.id && !state.leaving &&
      state.categoryQuestions[categoryId]?.questions?.[questionIndex]?.question === question.question;
    try {
      const response = await fetch(`/api/resume/${encodeURIComponent(resumeId)}/questions/${encodeURIComponent(categoryId)}/${questionIndex}/evaluate`, {
        method: 'POST',
        headers: { ...headers(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ answer }),
        signal: controller.signal,
      });
      if (!isCurrent()) return;
      if (unauthorized(response)) return;
      const data = await response.json().catch(() => ({}));
      if (!isCurrent()) return;
      if (!response.ok || data.category !== categoryId || data.questionIndex !== questionIndex ||
          !data.evaluation || !Number.isFinite(data.evaluation.score)) {
        throw new Error(typeof data.error === 'string' ? data.error : 'Unable to evaluate this answer. Please retry.');
      }
      question.answer = data.answer;
      question.evaluation = data.evaluation;
      state.answerDrafts[key] = data.answer;
      delete state.answerErrors[key];
    } catch (error) {
      if (!isCurrent() || error.name === 'AbortError') return;
      state.answerErrors[key] = error.message || 'Unable to evaluate this answer. Please retry.';
    } finally {
      const ownsRequestSlot = answerRequests.get(key) === controller;
      if (ownsRequestSlot) answerRequests.delete(key);
      if (ownsRequestSlot && uploadId === state.uploadId && resumeId === state.current?.id) {
        delete state.answerBusy[key];
        if (isCurrent()) renderCategoryInterface();
      }
    }
  }

  async function loadPractice() {
    if (!state.current || state.practiceLoading || state.practiceLoadedFor === state.current.id) return;
    const resumeId = state.current.id;
    const uploadId = state.uploadId;
    state.practiceLoading = true;
    state.practiceLoadError = '';
    renderCategoryInterface();
    try {
      const response = await fetch(`/api/resume/${encodeURIComponent(resumeId)}/practice`, { headers: headers() });
      if (uploadId !== state.uploadId || resumeId !== state.current?.id || state.leaving) return;
      if (unauthorized(response)) return;
      const data = await response.json().catch(() => ({}));
      if (uploadId !== state.uploadId || resumeId !== state.current?.id || state.leaving) return;
      if (!response.ok || !data.categories || typeof data.categories !== 'object') {
        throw new Error(typeof data.error === 'string' ? data.error : 'Could not restore saved answers and evaluations.');
      }
      for (const [categoryId, categoryRecord] of Object.entries(data.categories)) {
        if (questionCategories.some((category) => category.id === categoryId) && isOllamaResult(categoryRecord)) {
          state.categoryQuestions[categoryId] = categoryRecord;
          for (let index = 0; index < 6; index += 1) {
            const key = answerKey(categoryId, index);
            if (typeof categoryRecord.questions[index]?.answer === 'string') state.answerDrafts[key] = categoryRecord.questions[index].answer;
          }
        }
      }
      state.practiceLoadedFor = resumeId;
    } catch (error) {
      if (uploadId === state.uploadId && resumeId === state.current?.id) {
        state.practiceLoadError = error.message || 'Could not restore saved practice data.';
      }
    } finally {
      if (uploadId === state.uploadId && resumeId === state.current?.id && !state.leaving) {
        state.practiceLoading = false;
        renderCategoryInterface();
      }
    }
  }

  function selectTab(index, focus = false) {
    tabs.forEach((tab, i) => {
      tab.setAttribute('aria-selected', String(i === index)); tab.tabIndex = i === index ? 0 : -1;
      panels[i].hidden = i !== index;
    });
    setStep(1);
    if (focus) tabs[index].focus();
  }
  tabs.forEach((tab, index) => {
    tab.addEventListener('click', () => selectTab(index));
    tab.addEventListener('keydown', event => {
      let next;
      if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
      if (event.key === 'ArrowLeft') next = (index + tabs.length - 1) % tabs.length;
      if (event.key === 'Home') next = 0;
      if (event.key === 'End') next = tabs.length - 1;
      if (next !== undefined) { event.preventDefault(); selectTab(next, true); }
    });
  });
  function expandSetup(expand = true) {
    $('setupForm').hidden = !expand;
    $('setupPanel').classList.toggle('is-collapsed', !expand);
    $('setupSummary').hidden = expand || !state.current;
    $('editSetup').setAttribute('aria-expanded', String(expand));
    $('editSetup').textContent = expand ? 'Collapse setup' : 'Edit setup';
    if (expand) setStep(0);
  }
  $('editSetup').addEventListener('click', () => { expandSetup($('setupForm').hidden); if (!$('setupForm').hidden) focusSection($('setupTitle')); });
  $('stepResume').addEventListener('click', () => { expandSetup(); focusSection($('setupTitle')); });
  $('stepAnalysis').addEventListener('click', () => { selectTab(0); focusSection($('resultsTitle')); });
  $('stepQuestions').addEventListener('click', () => {
    if (!state.categoryWorkflowEntered || $('stepQuestions').disabled) return;
    setStep(2); focusSection($('questionsStageTitle'));
  });
  $('viewDetails').addEventListener('click', () => selectTab(1, true));
  $('backToOverview').addEventListener('click', () => { selectTab(0); $('tabOverview').focus(); });
  $('prepareQuestions').addEventListener('click', () => {
    if (!state.current || state.uploadBusy || !state.authenticated || state.leaving) return;
    state.categoryWorkflowEntered = true;
    if (!state.selectedCategory) state.selectedCategory = questionCategories[0].id;
    syncControls(); setStep(2); loadPractice(); focusSection($('questionsStageTitle'));
  });
  $('generateCategoryButton').addEventListener('click', () => generateCategory(state.selectedCategory));
  $('backToAnalysis').addEventListener('click', () => { selectTab(0); focusSection($('resultsTitle')); });

  function markDraft() {
    if (state.current) $('setupHelp').textContent = 'Changes apply when you analyze again. Current results keep their submitted context.';
  }
  ['targetRole', 'interviewType'].forEach(id => $(id).addEventListener('input', markDraft));
  function clearFile(message = '') {
    state.file = null; $('fileInput').value = '';
    $('selectedFile').hidden = true; $('fileName').textContent = ''; $('fileSize').textContent = '';
    $('fileError').textContent = message;
    $('chooseFile').setAttribute('aria-invalid', String(Boolean(message)));
    $('setupHelp').textContent = 'Choose a PDF to get started.';
    $('resumeStepState').textContent = state.current ? 'Previous resume analyzed' : 'Set up your interview';
    syncControls();
  }
  function acceptFiles(files) {
    if (state.uploadBusy || !state.authenticated || state.leaving || !files.length) return;
    // Rejecting a replacement clears the selection so an old PDF cannot be submitted silently.
    clearFile(); status('uploadStatus');
    if (files.length !== 1) { clearFile('Choose one resume at a time. No file was selected.'); return; }
    const file = files[0];
    if (file.type !== 'application/pdf') { clearFile('Choose a PDF file. The previous selection has been cleared.'); return; }
    if (file.size > MAX_FILE_SIZE) { clearFile('This PDF exceeds 5 MB. Choose a smaller file.'); return; }
    if (file.size === 0) { clearFile('This file is empty. Choose a PDF containing resume text.'); return; }
    state.file = file;
    $('selectedFile').hidden = false; $('fileName').textContent = file.name;
    $('fileSize').textContent = file.size >= 1024 * 1024 ? (file.size / 1024 / 1024).toFixed(1) + ' MB' : Math.max(1, Math.round(file.size / 1024)) + ' KB';
    $('setupHelp').textContent = 'Resume selected. Ready to analyze.';
    $('resumeStepState').textContent = 'Resume selected';
    status('uploadStatus', 'Resume selected. Review your interview setup, then analyze.');
    markDraft(); setStep(0); syncControls();
  }
  ['chooseFile', 'replaceFile'].forEach(id => $(id).addEventListener('click', () => {
    if (!state.uploadBusy) { $('fileInput').value = ''; $('fileInput').click(); }
  }));
  $('fileInput').addEventListener('change', event => acceptFiles(Array.from(event.target.files)));
  $('removeFile').addEventListener('click', () => {
    if (state.uploadBusy) return;
    clearFile(); status('uploadStatus', 'Local file selection removed. Any saved resume and its results are unchanged.');
    $('chooseFile').focus();
  });
  let dragDepth = 0;
  $('dropzone').addEventListener('dragenter', event => { event.preventDefault(); if (!state.uploadBusy) { dragDepth++; $('dropzone').classList.add('dragover'); } });
  $('dropzone').addEventListener('dragover', event => { event.preventDefault(); });
  $('dropzone').addEventListener('dragleave', event => { event.preventDefault(); if (--dragDepth <= 0) { dragDepth = 0; $('dropzone').classList.remove('dragover'); } });
  $('dropzone').addEventListener('drop', event => {
    event.preventDefault(); dragDepth = 0; $('dropzone').classList.remove('dragover');
    acceptFiles(Array.from(event.dataTransfer.files));
  });
  // Prevent dropping a file outside the upload area from navigating away.
  window.addEventListener('dragover', event => { if (Array.from(event.dataTransfer?.types || []).includes('Files')) event.preventDefault(); });
  window.addEventListener('drop', event => { if (Array.from(event.dataTransfer?.types || []).includes('Files')) event.preventDefault(); });

  function empty(parent, message = 'Not detected in this resume') { parent.append(node('p', message, 'empty-text')); }
  function textList(parent, values, className = 'text-list') {
    const items = strings(values);
    if (!items.length) { empty(parent); return; }
    const list = node('ul', '', className);
    items.forEach(value => list.append(node('li', value))); parent.append(list);
  }
  function source(parent, value, analysis = false) {
    parent.replaceChildren();
    const sourceValue = text(value);
    if (/^ollama-[a-z0-9][a-z0-9._:-]*$/i.test(sourceValue)) parent.append(node('span', analysis ? 'AI-assisted analysis' : 'AI-generated questions', 'badge badge-accent'));
    else if (sourceValue === 'heuristic-fallback') parent.append(node('span', 'Rule-based fallback', 'badge badge-warning'));
    else parent.append(node('span', 'Source not specified', 'badge'));
    if (sourceValue === 'heuristic-fallback') parent.append(node('p', 'Prepared with resume-based rules. These results are available to use.', 'helper'));
  }
  function detailsSection(title, wide = false) {
    const section = node('section', '', 'panel content-panel' + (wide ? ' details-wide' : ''));
    section.append(node('h3', title)); $('resumeDetails').append(section); return section;
  }
  function renderEntries(parent, values, render) {
    const items = records(values);
    if (!items.length) { empty(parent); return; }
    items.forEach(item => { const entry = node('article', '', 'entry'); render(entry, item); parent.append(entry); });
  }
  function contextLabel(snapshot) {
    return [snapshot.targetRole && 'Target role: ' + snapshot.targetRole, 'Interview type: ' + snapshot.interviewType].filter(Boolean).join(' / ');
  }
  function renderResults(data, snapshot) {
    const parsed = data.parsedResume || {};
    const analysis = data.analysis || {};
    const contact = parsed.contact || {};
    $('resultsTitle').textContent = text(contact.name) || 'Your resume analysis';
    $('resultsContext').textContent = contextLabel(snapshot);
    $('resultsFile').textContent = snapshot.file.name;
    $('questionContext').textContent = contextLabel(snapshot);
    $('setupSummary').textContent = snapshot.file.name + ' / ' + contextLabel(snapshot);
    source($('analysisSource'), analysis.source, true);
    $('analysisContent').replaceChildren();
    if (text(analysis.summary)) $('analysisContent').append(node('p', analysis.summary, 'prose'));
    else empty($('analysisContent'), 'A summary was not returned. You can still explore the extracted resume details.');
    for (const [title, values] of [['Strengths', analysis.strengths], ['Preparation focus', analysis.skillAreasToProbe]]) {
      const section = node('div', '', 'analysis-group'); section.append(node('h4', title));
      if (strings(values).length) textList(section, values); else empty(section, 'Not provided in this analysis');
      $('analysisContent').append(section);
    }
    $('keySkills').replaceChildren(); textList($('keySkills'), parsed.skills, 'pill-list');
    $('resumeFacts').replaceChildren();
    for (const [label, count] of [['Skills detected', strings(parsed.skills).length], ['Projects detected', records(parsed.projects).length], ['Experience entries', records(parsed.experience).length], ['PDF pages', Number.isFinite(data.pageCount) ? data.pageCount : null]]) {
      if (count === null) continue;
      const item = node('div'); item.append(node('dt', label), node('dd', count)); $('resumeFacts').append(item);
    }
    $('resumeDetails').replaceChildren();
    const contactSection = detailsSection('Contact');
    const contacts = [['Name', contact.name], ['Email', contact.email], ['Phone', contact.phone]].filter(([, value]) => text(value));
    if (contacts.length) {
      const dl = node('dl', '', 'contact-list');
      contacts.forEach(([label, value]) => { const pair = node('div'); pair.append(node('dt', label), node('dd', value)); dl.append(pair); }); contactSection.append(dl);
    } else empty(contactSection);
    textList(detailsSection('Skills'), parsed.skills, 'pill-list');
    renderEntries(detailsSection('Experience', true), parsed.experience, (entry, job) => {
      entry.append(node('h4', text(job.role) || 'Role not detected'));
      const meta = [text(job.organisation), text(job.duration)].filter(Boolean).join(' / ');
      if (meta) entry.append(node('p', meta, 'small secondary'));
      if (strings(job.responsibilities).length) textList(entry, job.responsibilities);
    });
    renderEntries(detailsSection('Projects', true), parsed.projects, (entry, project) => {
      entry.append(node('h4', text(project.title) || 'Project title not detected'));
      if (text(project.duration)) entry.append(node('p', project.duration, 'small secondary'));
      if (text(project.description)) entry.append(node('p', project.description, 'prose'));
      if (strings(project.technologies).length) textList(entry, project.technologies, 'pill-list');
    });
    renderEntries(detailsSection('Education'), parsed.education, (entry, education) => {
      entry.append(node('h4', text(education.degree) || 'Degree not detected'));
      const meta = [text(education.institution), text(education.year)].filter(Boolean).join(' / ');
      if (meta) entry.append(node('p', meta, 'small secondary'));
    });
    textList(detailsSection('Certifications'), parsed.certifications);
    const warnings = strings(parsed.meta?.warnings);
    $('extractionNotes').hidden = !warnings.length; $('extractionNotes').open = false;
    $('extractionNotesList').replaceChildren(); warnings.forEach(warning => $('extractionNotesList').append(node('li', warning)));
    $('rawJson').textContent = JSON.stringify(data, null, 2); $('technicalDetails').open = false;
    status('questionsStatus');
    $('prepareQuestions').textContent = 'Prepare interview questions';
    $('workspacePlaceholder').hidden = true; $('results').hidden = false;
    $('previousResultsNote').hidden = true; $('editSetup').hidden = false;
    $('analysisStepState').textContent = 'Analysis ready'; $('questionsStepState').textContent = 'Ready to generate';
    $('resumeStepState').textContent = 'Resume analyzed';
    expandSetup(false); syncControls(); selectTab(0); focusSection($('resultsTitle'));
  }

  $('setupForm').addEventListener('submit', async event => {
    event.preventDefault();
    if (!state.file || state.uploadBusy || !state.authenticated || state.leaving) return;
    const snapshot = { file: state.file, targetRole: $('targetRole').value, interviewType: $('interviewType').value || 'Technical' };
    const id = ++state.uploadId;
    uploadRequest?.abort(); uploadRequest = new AbortController();
    state.questionId++; questionRequest?.abort(); state.categoryBusy = '';
    for (const request of answerRequests.values()) request.abort();
    answerRequests.clear();
    state.answerBusy = Object.create(null); state.answerErrors = Object.create(null); state.answerDrafts = Object.create(null);
    status('questionsStatus');
    state.uploadBusy = true; status('uploadStatus'); syncControls();
    $('previousResultsNote').hidden = !state.current;
    $('analysisStepState').textContent = 'Processing resume';
    setStep(1);
    const body = new FormData();
    body.append('resume', snapshot.file); body.append('interviewType', snapshot.interviewType); body.append('targetRole', snapshot.targetRole);
    try {
      const res = await fetch('/api/resume/upload', { method: 'POST', headers: headers(), body, signal: uploadRequest.signal });
      if (id !== state.uploadId || state.leaving) return;
      if (unauthorized(res)) return;
      const data = await res.json().catch(() => ({}));
      if (id !== state.uploadId || state.leaving) return;
      if (!res.ok) {
        const message = res.status === 422 ? 'We could not read this resume. Use a text-based PDF rather than a scan, then try again.'
          : typeof data.error === 'string' ? data.error : 'Unable to process this resume. Please try again.';
        status('uploadStatus', message, 'error'); return;
      }
      if (typeof data.resumeId !== 'string' || !data.parsedResume || typeof data.parsedResume !== 'object') throw new Error('response');
      state.current = { id: data.resumeId, snapshot };
      state.categoryQuestions = Object.create(null); state.categoryErrors = Object.create(null); state.categoryInsufficient = Object.create(null);
      state.answerDrafts = Object.create(null); state.answerBusy = Object.create(null); state.answerErrors = Object.create(null);
      state.practiceLoading = false; state.practiceLoadError = ''; state.practiceLoadedFor = '';
      state.categoryWorkflowEntered = false; state.selectedCategory = '';
      renderResults(data, snapshot);
      status('uploadStatus', 'Analysis ready. Your results are below.', 'success');
    } catch (err) {
      if (id !== state.uploadId || state.leaving || err.name === 'AbortError') return;
      status('uploadStatus', 'We could not complete the request. Check your connection and try again. Any previous results are still available.', 'error');
    } finally {
      if (id === state.uploadId && !state.leaving) {
        state.uploadBusy = false; syncControls();
        $('analysisStepState').textContent = state.current ? 'Analysis ready' : 'Ready to retry';
      }
    }
  });

  window.addEventListener('storage', event => {
    if (event.key === 'resumeAppToken' || event.key === null) {
      state.leaving = true; invalidateRequests(); $('workspace').hidden = true; window.location.reload();
    }
  });
  window.addEventListener('pagehide', () => { state.leaving = true; invalidateRequests(); $('workspace').hidden = true; });
  window.addEventListener('pageshow', event => { if (event.persisted) window.location.reload(); });
  verifyAccess();
})();
