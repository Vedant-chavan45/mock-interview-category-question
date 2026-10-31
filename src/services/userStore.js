const User = require('../models/User');

const normalizeEmail = email => email.trim().toLowerCase();

async function findByEmail(email, { includePassword = false } = {}) {
  const query = User.findOne({ email: normalizeEmail(email) });
  if (includePassword) query.select('+passwordHash');
  return query;
}

async function findById(id) {
  return User.findById(id);
}

async function createUser({ name, email, passwordHash }) {
  // Whitelist persisted fields; callers cannot supply an ID or plaintext password.
  return User.create({ name: name.trim(), email: normalizeEmail(email), passwordHash });
}

module.exports = { normalizeEmail, findByEmail, findById, createUser };
