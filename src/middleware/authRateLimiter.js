/** In-process defense against repeated login/signup attempts. For multi-instance
 * deployments replace with a shared, persistent rate-limit store. */
const counters = new Map();
const WINDOW_MS = 15 * 60 * 1000;
const MAX_KEYS = 10000;

function limitAuthRequests(req, res, next) {
  const now = Date.now();
  const action = req.path === '/signup' ? 'signup' : 'login';
  const max = action === 'signup' ? 10 : 25;
  const address = req.ip || req.socket?.remoteAddress || 'unknown';
  const key = `${action}:${address}`;
  if (counters.size >= MAX_KEYS) {
    for (const [candidate, value] of counters) {
      if (value.until <= now) counters.delete(candidate);
    }
    // Avoid unbounded memory growth from attacker-controlled IP cardinality.
    if (counters.size >= MAX_KEYS && !counters.has(key)) {
      res.setHeader('Retry-After', '60');
      return res.status(429).json({ error: 'Too many authentication requests. Try again later.' });
    }
  }
  let state = counters.get(key);
  if (!state || now >= state.until) state = { count: 0, until: now + WINDOW_MS };
  if (state.count >= max) {
    res.setHeader('Retry-After', String(Math.ceil((state.until - now) / 1000)));
    return res.status(429).json({ error: 'Too many authentication requests. Try again later.' });
  }
  state.count += 1;
  counters.set(key, state);
  return next();
}

module.exports = { limitAuthRequests };
