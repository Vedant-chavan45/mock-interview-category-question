const authService = require('../services/authService');
const userStore = require('../services/userStore');

const invalidCredentials = { error: 'Invalid email or password.' };
const duplicateEmail = { error: 'An account with this email already exists.' };
// Unknown accounts still perform a bcrypt verification.
const dummyHash = authService.hashPassword('unknown-account-placeholder');
const validEmail = value => typeof value === 'string' && value.trim().length <= 254 &&
  /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());

function signupError(body) {
  if (!body || typeof body.name !== 'string' || !body.name.trim() || body.name.trim().length > 100) {
    return 'Name is required and must be at most 100 characters.';
  }
  if (!validEmail(body.email)) return 'Enter a valid email address.';
  if (typeof body.password !== 'string' || body.password.length < 8) return 'Password must contain at least 8 characters.';
  if (Buffer.byteLength(body.password, 'utf8') > 72) return 'Password must not exceed 72 UTF-8 bytes.';
  if (typeof body.confirmPassword !== 'string' || body.confirmPassword !== body.password) return 'Password confirmation must match.';
  return null;
}

function authResponse(user) {
  const publicUser = { id: user.id, name: user.name, email: user.email };
  return { token: authService.generateToken(publicUser), user: publicUser };
}

async function signup(req, res) {
  const error = signupError(req.body);
  if (error) return res.status(400).json({ error });
  try {
    const email = userStore.normalizeEmail(req.body.email);
    if (await userStore.findByEmail(email)) return res.status(409).json(duplicateEmail);
    const user = await userStore.createUser({
      name: req.body.name.trim(), email,
      passwordHash: authService.hashPassword(req.body.password),
    });
    return res.status(201).json(authResponse(user));
  } catch (err) {
    if (err.code === 11000) return res.status(409).json(duplicateEmail);
    // Driver errors may contain connection details; do not expose them.
    return res.status(500).json({ error: 'Unable to create account. Please try again.' });
  }
}

async function login(req, res) {
  const { email, password } = req.body || {};
  if (typeof email !== 'string' || !email.trim() || typeof password !== 'string' || !password) {
    return res.status(400).json({ error: 'Email and password are required.' });
  }
  if (!validEmail(email) || Buffer.byteLength(password, 'utf8') > 72) return res.status(401).json(invalidCredentials);
  try {
    const user = await userStore.findByEmail(userStore.normalizeEmail(email), { includePassword: true });
    const valid = authService.verifyPassword(password, user ? user.passwordHash : dummyHash);
    if (!user || !valid) return res.status(401).json(invalidCredentials);
    return res.json(authResponse(user));
  } catch {
    return res.status(500).json({ error: 'Unable to sign in. Please try again.' });
  }
}

function me(req, res) {
  return res.json({ user: req.user });
}

module.exports = { signup, login, me };
