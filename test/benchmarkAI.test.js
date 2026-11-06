'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');
const { main, parseArgs, statistics, buildSyntheticContext } = require('../scripts/benchmarkAI');

test('benchmark CLI validates category and run count and defaults to one safe category', () => {
  assert.deepEqual(parseArgs([]).categories, ['domain_fundamentals']);
  assert.equal(parseArgs([]).runs, 1);
  assert.equal(parseArgs(['--category', 'all', '--runs', '2']).categories.length, 6);
  assert.throws(() => parseArgs(['--category', 'unknown']), /Invalid category/);
  assert.throws(() => parseArgs(['--runs', '0']), /--runs must be an integer/);
  assert.throws(() => parseArgs(['--runs', '1.5']), /--runs must be an integer/);
});

test('benchmark dry-run builds only the synthetic context and reports no inference or database access', async (t) => {
  const original = process.env.AI_PROVIDER;
  process.env.AI_PROVIDER = 'unsupported-provider';
  t.after(() => {
    if (original === undefined) delete process.env.AI_PROVIDER;
    else process.env.AI_PROVIDER = original;
  });
  const logs = [];
  let modelCalls = 0;
  t.mock.method(axios, 'post', async () => { modelCalls += 1; throw new Error('dry-run must not call Ollama'); });
  t.mock.method(console, 'log', (line) => logs.push(line));
  await main(['--dry-run', '--category', 'technical_concepts', '--runs', '2']);
  const result = JSON.parse(logs[0]);
  assert.equal(result.preflight, 'passed');
  assert.equal(result.inferencePerformed, false);
  assert.equal(result.databaseRequired, false);
  assert.equal(result.resumeContextReady, true);
  assert.equal(modelCalls, 0);
  assert.equal(result.runsPerCategory, 2);
  assert.deepEqual(result.categoryIds, ['technical_concepts']);
  const context = buildSyntheticContext();
  assert.equal(context.targetRole, 'Backend Developer');
  assert.ok(context.projects.some((project) => project.title === 'Synthetic Ticket Routing API'));
});

test('benchmark reports aggregate statistics with sample count and exploratory p95 for small samples', () => {
  assert.deepEqual(statistics([30, 10, 20]), {
    sampleCount: 3, minMs: 10, meanMs: 20, medianMs: 20, p95Ms: 30, p95Exploratory: true,
  });
  assert.equal(statistics(Array.from({ length: 20 }, (_, index) => index + 1)).p95Exploratory, false);
  assert.equal(statistics([]).sampleCount, 0);
});
