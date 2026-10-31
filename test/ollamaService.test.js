const test = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');
const { generateJsonWithRetry } = require('../src/services/ollamaService');

test('resume analysis does not retry request/network errors', async (t) => {
  const post = t.mock.method(axios, 'post', async () => {
    const error = new axios.AxiosError('private request detail', 'ECONNABORTED');
    throw error;
  });
  await assert.rejects(generateJsonWithRetry('safe test prompt'), (error) => error.code === 'ECONNABORTED');
  assert.equal(post.mock.callCount(), 1);
});

test('resume analysis retries malformed JSON at most once', async (t) => {
  let attempts = 0;
  const post = t.mock.method(axios, 'post', async () => {
    attempts += 1;
    return { data: { response: attempts === 1 ? 'not json' : '{"summary":"ok"}' } };
  });
  assert.deepEqual(await generateJsonWithRetry('safe test prompt'), { summary: 'ok' });
  assert.equal(post.mock.callCount(), 2);
});
