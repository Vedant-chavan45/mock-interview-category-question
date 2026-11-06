/**
 * server.js
 * -----------------------------------------------------------------------
 * Module 4 — Resume Processing & Resume Intelligence — standalone service
 * Owner: Siddhant Raikar
 *
 * Runs this module as its own Express server so it can be demoed on its
 * own (Postman / curl / a simple HTML form), and shows exactly how it
 * plugs into the full team backend — see README.md "Integration" section
 * for the one-line mount into the main app's app.js.
 * -----------------------------------------------------------------------
 */

require('dotenv').config();
const path = require('path');
const express = require('express');
const cors = require('cors');
const resumeRoutes = require('./src/routes/resumeRoutes');
const authRoutes = require('./src/routes/authRoutes');
const { requireAuth } = require('./src/middleware/authMiddleware');

const { connectDatabase, getDatabaseState } = require('./src/config/database');
const { initializeUsers, DemoSeedError } = require('./src/services/seedDemoUser');
const { validateSecurityEnvironment } = require('./src/config/security');

const app = express();
const PORT = process.env.PORT || 5001;
// Never expose development/demo credentials on the LAN by default.
const HOST = process.env.HOST || (process.env.NODE_ENV === 'production' ? '0.0.0.0' : '127.0.0.1');
// Enable only when behind a trusted reverse proxy that sanitizes X-Forwarded-For.
const proxyHops = Number(process.env.TRUST_PROXY_HOPS || 0);
if (Number.isInteger(proxyHops) && proxyHops > 0 && proxyHops <= 3) {
  app.set('trust proxy', proxyHops);
}

// Same-origin frontend is the default; explicitly allow known external frontends.
const allowedOrigins = (process.env.CORS_ALLOWED_ORIGINS || '').split(',').map(v => v.trim()).filter(Boolean);
if (allowedOrigins.length) {
  app.use(cors({ origin(origin, callback) {
    callback(null, Boolean(origin && allowedOrigins.includes(origin)));
  }, methods: ['GET', 'POST'], allowedHeaders: ['Content-Type', 'Authorization'] }));
}
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  if (req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
  next();
});
app.use(express.json({ limit: '64kb' }));

app.get('/health', (req, res) => {
  const mongodb = getDatabaseState();
  const connected = mongodb === 'connected';
  res.status(connected ? 200 : 503).json({ status: connected ? 'ok' : 'degraded', module: 'resume-processing', owner: 'Siddhant Raikar', mongodb });
});

app.use('/api/auth', authRoutes);

// Resume routes sit behind a login (matches the team's JWT + bcrypt stack
// on the HLD slide) — see src/middleware/authMiddleware.js.
app.use('/api/resume', requireAuth, resumeRoutes);

// Public welcome page; /index.html remains the authenticated application.
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'welcome.html')));

// Static demo webpage — login page + drag-and-drop resume UI, so the
// module can be demoed in a browser instead of via curl/Postman.
// Visit http://localhost:PORT/ once the server is running.
app.use(express.static(path.join(__dirname, 'public')));

// Multer / validation errors land here with a clean JSON response instead
// of a stack trace — matters for a live demo.
app.use((err, req, res, next) => {
  if (err && err.name === 'MulterError') {
    return res.status(400).json({ error: `Upload error: ${err.message}` });
  }
  console.error(err);
  return res.status(500).json({ error: 'Internal server error.' });
});

if (require.main === module) {
  validateSecurityEnvironment();
  connectDatabase().then(initializeUsers).then(() => app.listen(PORT, HOST, () => {
    console.log(`Resume Processing module listening on http://localhost:${PORT}`);
    console.log(`Demo webpage:  http://localhost:${PORT}/`);
  })).catch(async (err) => {
    const safeDatabaseErrors = [
      'MONGODB_URI must be configured.',
      'MongoDB connection failed. Check database configuration and network access.',
    ];
    const message = err instanceof DemoSeedError || safeDatabaseErrors.includes(err.message)
      ? err.message : 'User database initialization failed. Check database permissions and indexes.';
    console.error('[startup]', message);
    await require('mongoose').disconnect().catch(() => {});
    process.exitCode = 1;
  });
}

module.exports = app;
