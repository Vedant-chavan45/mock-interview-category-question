(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const form = $('loginForm');
  let signup = false;
  let busy = false;
  let sequence = 0;
  let request;
  let leaving = false;

  function setBusy(value, label) {
    busy = value;
    $('authFields').disabled = value;
    $('toggleMode').disabled = value;
    form.setAttribute('aria-busy', String(value));
    $('loginBtn').textContent = label || (signup ? 'Create account' : 'Sign in');
  }
  function fieldError(id, message = '') {
    $(id).setAttribute('aria-invalid', String(Boolean(message)));
    $(id + 'Error').textContent = message;
    $(id + 'Error').hidden = !message;
  }
  function clearErrors() {
    ['name', 'email', 'password', 'confirmPassword'].forEach(id => fieldError(id));
    $('authError').textContent = '';
    $('authStatus').textContent = '';
  }
  function clearCredentials() {
    localStorage.removeItem('resumeAppToken');
    localStorage.removeItem('resumeAppUser');
  }
  function resetVisibility() {
    document.querySelectorAll('[data-password]').forEach(button => {
      $(button.dataset.password).type = 'password';
      button.textContent = 'Show';
      button.setAttribute('aria-pressed', 'false');
      button.setAttribute('aria-label', button.dataset.password === 'password' ? 'Show password' : 'Show confirmation password');
    });
  }
  document.querySelectorAll('[data-password]').forEach(button => {
    button.addEventListener('click', () => {
      const input = $(button.dataset.password);
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      button.textContent = show ? 'Hide' : 'Show';
      button.setAttribute('aria-pressed', String(show));
      button.setAttribute('aria-label', (show ? 'Hide ' : 'Show ') + (input.id === 'password' ? 'password' : 'confirmation password'));
    });
  });
  $('toggleMode').addEventListener('click', () => {
    if (busy) return;
    signup = !signup;
    clearErrors(); resetVisibility();
    $('nameField').hidden = $('confirmField').hidden = $('passwordHelp').hidden = !signup;
    $('name').required = $('confirmPassword').required = signup;
    $('password').autocomplete = signup ? 'new-password' : 'current-password';
    $('password').value = $('confirmPassword').value = '';
    $('authTitle').textContent = signup ? 'Create your account' : 'Welcome back';
    $('authSubtitle').textContent = signup ? 'Start with your experience. Prepare with direction.' : 'Sign in to prepare for your next opportunity.';
    $('authLegend').textContent = signup ? 'Create account details' : 'Sign in details';
    $('switchPrompt').textContent = signup ? 'Already have an account?' : 'New to Resume Intelligence?';
    $('toggleMode').textContent = signup ? 'Sign in instead' : 'Create an account';
    document.title = (signup ? 'Create account' : 'Sign in') + ' | Resume Intelligence';
    document.querySelector('.skip-link').textContent = signup ? 'Skip to create account' : 'Skip to sign in';
    setBusy(false);
    $(signup ? 'name' : 'email').focus();
  });
  ['name', 'email', 'password', 'confirmPassword'].forEach(id => {
    $(id).addEventListener('input', () => fieldError(id));
  });

  async function validateSavedToken() {
    if (leaving) return;
    const current = ++sequence;
    request?.abort(); request = new AbortController();
    $('retryAuth').hidden = true; clearErrors(); setBusy(true);
    try {
      const token = localStorage.getItem('resumeAppToken');
      if (!token) { setBusy(false); return; }
      $('authStatus').textContent = 'Checking your saved sign-in...';
      const res = await fetch('/api/auth/me', { headers: { Authorization: `Bearer ${token}` }, signal: request.signal });
      if (current !== sequence || leaving) return;
      if (res.status === 401) {
        clearCredentials(); setBusy(false);
        $('authStatus').textContent = 'Your sign-in has expired. Please sign in again.';
        return;
      }
      if (!res.ok) throw new Error('verification');
      const data = await res.json();
      if (current !== sequence || leaving) return;
      if (!data.user || typeof data.user.id !== 'string') throw new Error('verification');
      localStorage.setItem('resumeAppUser', JSON.stringify(data.user));
      leaving = true; window.location.replace('/index.html');
    } catch (err) {
      if (current !== sequence || leaving || err.name === 'AbortError') return;
      $('authStatus').textContent = '';
      $('authError').textContent = 'We could not verify your saved sign-in. Check your connection and browser storage settings, then retry. Your credentials have not been cleared.';
      $('retryAuth').hidden = false;
    }
  }
  $('retryAuth').addEventListener('click', validateSavedToken);

  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (busy || leaving) return;
    clearErrors();
    const body = { email: $('email').value.trim(), password: $('password').value };
    let firstError;
    const invalid = (id, text) => { fieldError(id, text); firstError ||= id; };
    if (signup && (!$('name').value.trim() || $('name').value.trim().length > 100)) invalid('name', 'Enter a name of 1 to 100 characters.');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email) || body.email.length > 254) invalid('email', 'Enter a valid email address.');
    if (!body.password || (signup && body.password.length < 8)) invalid('password', signup ? 'Use at least 8 characters.' : 'Enter your password.');
    else if (new TextEncoder().encode(body.password).length > 72) invalid('password', 'Use a password of at most 72 UTF-8 bytes.');
    if (signup && (! $('confirmPassword').value || $('confirmPassword').value !== body.password)) invalid('confirmPassword', 'Enter the same password in both fields.');
    if (firstError) { $(firstError).focus(); return; }
    if (signup) Object.assign(body, { name: $('name').value.trim(), confirmPassword: $('confirmPassword').value });
    const current = ++sequence;
    request?.abort(); request = new AbortController();
    setBusy(true, signup ? 'Creating account...' : 'Signing in...');
    $('authStatus').textContent = signup ? 'Creating your account...' : 'Signing you in...';
    let authenticated = false;
    try {
      const res = await fetch(signup ? '/api/auth/signup' : '/api/auth/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: request.signal,
      });
      if (current !== sequence || leaving) return;
      const data = await res.json().catch(() => ({}));
      if (current !== sequence || leaving) return;
      if (!res.ok) {
        $('authStatus').textContent = '';
        const message = typeof data.error === 'string' ? data.error : 'Unable to sign in. Please try again.';
        $('authError').textContent = message;
        if (signup && res.status === 409) { fieldError('email', message); setBusy(false); $('email').focus(); }
        return;
      }
      if (typeof data.token !== 'string' || !data.user || typeof data.user.id !== 'string') throw new Error('response');
      authenticated = true;
      try {
        localStorage.setItem('resumeAppToken', data.token);
        localStorage.setItem('resumeAppUser', JSON.stringify(data.user));
      } catch {
        try { clearCredentials(); } catch { /* Browser storage is unavailable. */ }
        throw new Error('storage');
      }
      $('authStatus').textContent = signup ? 'Account created. Opening your workspace...' : 'Signed in. Opening your workspace...';
      leaving = true; window.location.replace('/index.html');
    } catch (err) {
      if (current !== sequence || leaving || err.name === 'AbortError') return;
      $('authStatus').textContent = '';
      $('authError').textContent = authenticated
        ? 'Your account is ready, but this browser could not save your sign-in. Enable browser storage, then sign in.'
        : 'Unable to connect or read the server response. Please try again. If you were creating an account, try signing in before submitting again.';
    } finally {
      if (current === sequence && !leaving) setBusy(false);
    }
  });
  window.addEventListener('storage', event => {
    if (event.key === 'resumeAppToken' || event.key === null) validateSavedToken();
  });
  window.addEventListener('pagehide', () => { leaving = true; sequence++; request?.abort(); });
  window.addEventListener('pageshow', event => { if (event.persisted) window.location.reload(); });
  validateSavedToken();
})();
