const User = require('../models/User');
const authService = require('./authService');
const { normalizeEmail } = require('./userStore');

const DEMO_ID = '000000000000000000000001';
class DemoSeedError extends Error {}

function getDemoConfig() {
  const id = process.env.DEMO_USER_ID || DEMO_ID;
  const email = normalizeEmail(process.env.DEMO_USER_EMAIL || 'siddhant@capstone.demo');
  const name = (process.env.DEMO_USER_NAME || 'Siddhant Raikar').trim();
  const password = process.env.DEMO_USER_PASSWORD || 'demo1234';
  if (id !== DEMO_ID) throw new DemoSeedError('DEMO_USER_ID must be 000000000000000000000001 to preserve resume ownership.');
  if (!name || name.length > 100 || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new DemoSeedError('Invalid demo user name or email configuration.');
  }
  if (password.length < 8 || Buffer.byteLength(password, 'utf8') > 72) {
    throw new DemoSeedError('Demo password must contain at least 8 characters and at most 72 UTF-8 bytes.');
  }
  return { id, email, name, password };
}

async function findExisting(config) {
  const byId = await User.findById(config.id);
  const byEmail = await User.findOne({ email: config.email });
  if (byId && byId.email !== config.email) {
    throw new DemoSeedError('Demo seed conflict: the fixed demo ID belongs to another email.');
  }
  if (byEmail && byEmail.id !== config.id) {
    throw new DemoSeedError('Demo seed conflict: the configured demo email belongs to another ID.');
  }
  return byId;
}

async function seedDemoUser() {
  const config = getDemoConfig();
  const existing = await findExisting(config);
  if (existing) return existing;
  try {
    return await User.create({
      _id: config.id, name: config.name, email: config.email,
      passwordHash: authService.hashPassword(config.password),
    });
  } catch (err) {
    if (err.code === 11000) {
      // Another process may have seeded the same account after our lookup.
      const winner = await findExisting(config);
      if (winner) return winner;
      throw new DemoSeedError('Demo seed conflict: duplicate user identity.');
    }
    throw err;
  }
}

async function initializeUsers() {
  // Explicitly ensure the index even if autoIndex is disabled in a deployment.
  await User.createIndexes();
  await seedDemoUser();
}

module.exports = { seedDemoUser, initializeUsers, getDemoConfig, DemoSeedError };
