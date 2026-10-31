(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const MAX_FILE_SIZE = 5 * 1024 * 1024;
  const state = { token: '', authenticated: false, leaving: false, file: null, current: null,
    uploadBusy: false, questionBusy: false, uploadId: 0, questionId: 0, authId: 0, questions: [] };
  let authRequest, uploadRequest, questionRequest;
  const tabs = ['tabOverview', 'tabDetails', 'tabQuestions'].map($);
  const panels = ['overviewPanel', 'detailsPanel', 'questionsPanel'].map($);
  const text = value => typeof value === 'string' || typeof value === 'number' ? String(value) : '';
  const strings = value => Array.isArray(value) ? value.filter(item => typeof item === 'string' && item.trim()) : [];
  const records = value => Array.isArray(value) ? value.filter(item => item && typeof item === 'object' && !Array.isArray(item)) : [];
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
    $('generateQuestionsBtn').disabled = !state.current || state.uploadBusy || state.questionBusy || !state.authenticated;
    $('questionsList').setAttribute('aria-busy', String(state.questionBusy));
    $('stepAnalysis').disabled = $('stepQuestions').disabled = !state.current;
  }
  function setStep(index) {
    ['stepResume', 'stepAnalysis', 'stepQuestions'].forEach((id, i) => {
      if (i === index) $(id).setAttribute('aria-current', 'step'); else $(id).removeAttribute('aria-current');
    });
  }
  function selectTab(index, focus = false) {
    tabs.forEach((tab, i) => {
      tab.setAttribute('aria-selected', String(i === index)); tab.tabIndex = i === index ? 0 : -1;
      panels[i].hidden = i !== index;
    });
    setStep(index === 2 ? 2 : 1);
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
  $('stepQuestions').addEventListener('click', () => { selectTab(2, true); });
  $('viewDetails').addEventListener('click', () => selectTab(1, true));
  $('prepareQuestions').addEventListener('click', () => selectTab(2, true));

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
    if (sourceValue.startsWith('ollama')) parent.append(node('span', analysis ? 'AI-assisted analysis' : 'AI-assisted questions', 'badge badge-accent'));
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
    $('questionsList').replaceChildren(); $('questionsSource').replaceChildren(); status('questionsStatus');
    $('questionsEmpty').hidden = false;
    $('questionsEmpty').replaceChildren(node('h4', 'Your next step: prepare your answers'), node('p', 'Generate questions to explore your skills, projects and experience.'));
    $('generateQuestionsBtn').textContent = 'Generate questions';
    $('workspacePlaceholder').hidden = true; $('results').hidden = false;
    $('previousResultsNote').hidden = true; $('editSetup').hidden = false;
    $('analysisStepState').textContent = 'Analysis ready'; $('questionsStepState').textContent = 'Ready to generate';
    $('resumeStepState').textContent = 'Resume analyzed';
    expandSetup(false); selectTab(0); focusSection($('resultsTitle'));
  }

  $('setupForm').addEventListener('submit', async event => {
    event.preventDefault();
    if (!state.file || state.uploadBusy || !state.authenticated || state.leaving) return;
    const snapshot = { file: state.file, targetRole: $('targetRole').value, interviewType: $('interviewType').value || 'Technical' };
    const id = ++state.uploadId;
    uploadRequest?.abort(); uploadRequest = new AbortController();
    state.questionId++; questionRequest?.abort(); state.questionBusy = false;
    status('questionsStatus'); $('generateQuestionsBtn').textContent = state.questions.length ? 'Regenerate questions' : 'Generate questions';
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
      state.current = { id: data.resumeId, snapshot }; state.questions = [];
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

  $('generateQuestionsBtn').addEventListener('click', async () => {
    if (!state.current || state.questionBusy || state.uploadBusy || !state.authenticated || state.leaving) return;
    const resumeId = state.current.id;
    const uploadId = state.uploadId;
    const id = ++state.questionId;
    questionRequest?.abort(); questionRequest = new AbortController();
    const current = () => id === state.questionId && uploadId === state.uploadId && resumeId === state.current?.id && !state.leaving;
    state.questionBusy = true; syncControls();
    $('generateQuestionsBtn').textContent = 'Generating questions...';
    status('questionsStatus', state.questions.length ? 'Preparing a new set. Your previous questions remain below.' : 'Preparing questions from your resume and interview context...');
    try {
      const res = await fetch(`/api/resume/${encodeURIComponent(resumeId)}/questions`, { headers: headers(), signal: questionRequest.signal });
      if (!current()) return;
      if (unauthorized(res)) return;
      const data = await res.json().catch(() => ({}));
      if (!current()) return;
      if (!res.ok) throw new Error('request');
      const questions = records(data.questions).filter(q => text(q.question).trim());
      if (!questions.length) {
        status('questionsStatus', 'No questions were returned. Try generating again. Any previous questions are still shown.', 'warning');
        $('generateQuestionsBtn').textContent = 'Retry generation'; return;
      }
      const fragment = document.createDocumentFragment();
      questions.forEach(question => {
        const li = node('li'); li.append(node('p', question.question, 'question-body'));
        const meta = node('div', '', 'question-meta');
        if (text(question.type)) meta.append(node('span', question.type, 'badge'));
        if (text(question.basedOn)) meta.append(node('p', 'Based on: ' + text(question.basedOn)));
        li.append(meta); fragment.append(li);
      });
      $('questionsList').replaceChildren(fragment); state.questions = questions;
      $('questionsEmpty').hidden = true; source($('questionsSource'), data.source);
      status('questionsStatus', `${questions.length} questions ready. Take your time and practice each answer.`, 'success');
      $('generateQuestionsBtn').textContent = 'Regenerate questions';
      $('questionsStepState').textContent = 'Questions ready';
    } catch (err) {
      if (!current() || err.name === 'AbortError') return;
      status('questionsStatus', 'Unable to generate questions. Please retry. Any previous questions remain available below.', 'error');
      $('generateQuestionsBtn').textContent = 'Retry generation';
    } finally {
      if (current()) { state.questionBusy = false; syncControls(); }
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
