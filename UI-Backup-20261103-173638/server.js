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

const app = express();
const PORT = process.env.PORT || 5001;

app.use(cors());
app.use(express.json());

app.get('/health', (req, res) => {
  const mongodb = getDatabaseState();
  const connected = mongodb === 'connected';
  res.status(connected ? 200 : 503).json({ status: connected ? 'ok' : 'degraded', module: 'resume-processing', owner: 'Siddhant Raikar', mongodb });
});

app.use('/api/auth', authRoutes);

// Resume routes sit behind a login (matches the team's JWT + bcrypt stack
// on the HLD slide) — see src/middleware/authMiddleware.js.
app.use('/api/resume', requireAuth, resumeRoutes);

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
  connectDatabase().then(initializeUsers).then(() => app.listen(PORT, () => {
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
