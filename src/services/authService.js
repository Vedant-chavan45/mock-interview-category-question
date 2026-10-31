/** JWT + bcrypt authentication for the standalone demo account. */
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'demo-only-secret-change-in-integration';
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '4h';
const BCRYPT_SALT_ROUNDS = 10;

function hashPassword(plainPassword) {
  return bcrypt.hashSync(plainPassword, BCRYPT_SALT_ROUNDS);
}

function verifyPassword(plainPassword, passwordHash) {
  return bcrypt.compareSync(plainPassword, passwordHash);
}

function generateToken(user) {
  return jwt.sign(
    { sub: user.id, email: user.email, name: user.name },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN }
  );
}

function verifyToken(token) {
  return jwt.verify(token, JWT_SECRET);
}

module.exports = { hashPassword, verifyPassword, generateToken, verifyToken };
