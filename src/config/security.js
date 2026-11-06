/** Startup-only guardrails: fail closed rather than expose default credentials. */
function validateSecurityEnvironment(env = process.env) {
  if (env.NODE_ENV !== 'production') return;
  const secret = env.JWT_SECRET || '';
  if (Buffer.byteLength(secret, 'utf8') < 32 ||
      /^(?:demo-only-secret-change-in-integration|replace-this-with-a-private-random-secret)$/i.test(secret)) {
    throw new Error('Production requires a private JWT_SECRET of at least 32 bytes.');
  }
  if (env.SEED_DEMO_USER === '1' && (!env.DEMO_USER_PASSWORD || env.DEMO_USER_PASSWORD === 'demo1234')) {
    throw new Error('Production demo seeding requires a strong, non-default DEMO_USER_PASSWORD.');
  }
}
module.exports = { validateSecurityEnvironment };
