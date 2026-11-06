'use strict';

// Run: npm run check:ollama
// Reads only the Ollama configuration. Does not connect to MongoDB or log secrets.
try { require('dotenv').config(); } catch { /* NODE_ENV may supply values without dotenv */ }

const rawUrl = process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434';
const baseUrl = rawUrl.replace(/\/+$/, '');
const model = process.env.OLLAMA_MODEL || 'llama3.2';
const connectOnly = process.argv.includes('--connect-only');

async function jsonRequest(endpoint, init = {}, timeoutMs = 10000) {
  let response;
  try {
    response = await fetch(`${baseUrl}${endpoint}`, {
      ...init,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    if (error.name === 'TimeoutError' || error.name === 'AbortError') {
      throw new Error(`The ${endpoint} request timed out after ${timeoutMs / 1000} seconds.`);
    }
    const cause = error.cause?.code || error.code || 'NETWORK_ERROR';
    throw new Error(`Cannot reach Ollama (${cause}) at ${baseUrl}. Start Ollama with "ollama serve" or check OLLAMA_BASE_URL.`);
  }
  let data;
  try { data = await response.json(); } catch { data = {}; }
  if (!response.ok) {
    const hint = response.status === 404
      ? 'Configured model or endpoint was not found.'
      : response.status === 400 ? 'Model or request format was rejected.' : 'Ollama returned an error.';
    throw new Error(`Ollama ${endpoint} returned HTTP ${response.status}. ${hint}`);
  }
  return data;
}

async function main() {
  console.log(`Checking Ollama at ${baseUrl}`);
  const started = Date.now();
  const tags = await jsonRequest('/api/tags');
  const installed = Array.isArray(tags.models) ? tags.models.map((item) => item.name || item.model).filter(Boolean) : [];
  console.log(`Connection: OK (${Date.now() - started} ms)`);
  console.log(`Installed models: ${installed.join(', ') || '(none)'}`);
  const canonical = (name) => String(name).includes(':') ? String(name) : `${name}:latest`;
  if (!installed.some((name) => canonical(name) === canonical(model))) {
    throw new Error(`OLLAMA_MODEL=${model} is not installed. Choose an installed model in .env or run: ollama pull ${model}`);
  }
  console.log(`Configured model: ${model} (installed)`);
  if (connectOnly) return;
  console.log('Testing one small model generation (this may take time on first load)...');
  const requestStarted = Date.now();
  const result = await jsonRequest('/api/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, prompt: 'Reply with the single word OK.', stream: false,
      options: { num_predict: 16, num_ctx: 2048 } }),
  }, 90000);
  if (typeof result.response !== 'string' || !result.response.trim()) {
    throw new Error('Ollama responded but generated no text. Check the selected model and server logs.');
  }
  console.log(`Generation: OK (${Date.now() - requestStarted} ms)`);
  console.log('Ollama is reachable and the configured model can generate text.');
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`OLLAMA CHECK FAILED: ${error.message}`);
    process.exitCode = 1;
  });
}
module.exports = { main, jsonRequest };
