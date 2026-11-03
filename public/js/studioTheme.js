(() => {
  'use strict';
  const toggle = document.getElementById('themeToggle');
  const label = document.getElementById('themeToggleLabel');
  if (!toggle || !label) return;
  const storageKey = 'riWorkspaceTheme';
  let mode = 'dark';
  try { if (localStorage.getItem(storageKey) === 'light') mode = 'light'; } catch { /* Local storage is optional. */ }
  const paint = () => {
    document.documentElement.dataset.theme = mode;
    toggle.setAttribute('aria-pressed', String(mode === 'light'));
    toggle.setAttribute('aria-label', `Switch to ${mode === 'light' ? 'dark' : 'light'} mode`);
    label.textContent = mode === 'light' ? 'Dark mode' : 'Light mode';
    const path = mode === 'light'
      ? '<circle cx="12" cy="12" r="4" stroke="currentColor" stroke-width="1.6"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M4.93 4.93l1.42 1.42m11.3 11.3 1.42 1.42M19.07 4.93l-1.42 1.42M6.35 17.65l-1.42 1.42" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>'
      : '<path d="M19.2 15.2A8 8 0 0 1 8.8 4.8 8 8 0 1 0 19.2 15.2Z" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>';
    toggle.querySelector('svg').innerHTML = path;
  };
  toggle.addEventListener('click', () => {
    mode = mode === 'light' ? 'dark' : 'light';
    try { localStorage.setItem(storageKey, mode); } catch { /* Theme stays active for this page. */ }
    paint();
  });
  paint();
})();
