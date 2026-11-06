'use strict';

const SUPPORTED_PROVIDERS = new Set(['ollama', 'groq']);

function getAIConfig(env = process.env) {
  const provider = typeof env.AI_PROVIDER === 'string' && env.AI_PROVIDER.trim()
    ? env.AI_PROVIDER.trim().toLowerCase()
    : 'ollama';
  const model = provider === 'groq'
    ? (env.GROQ_MODEL?.trim() || 'openai/gpt-oss-120b')
    : (env.OLLAMA_MODEL?.trim() || 'llama3.2');
  return { provider, model };
}

function getAISource(env = process.env) {
  const { provider, model } = getAIConfig(env);
  return `${provider}-${model}`;
}

function isValidAISource(source, model) {
  if (typeof source !== 'string' || typeof model !== 'string' || !model.trim()) return false;
  return [...SUPPORTED_PROVIDERS].some((provider) => source === `${provider}-${model}`);
}

module.exports = { getAIConfig, getAISource, isValidAISource, SUPPORTED_PROVIDERS };
