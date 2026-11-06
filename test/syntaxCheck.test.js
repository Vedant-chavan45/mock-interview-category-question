'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const sources = [
  'public/js/app.js',
  'scripts/benchmarkAI.js',
  'src/ai/config.js',
  'src/ai/modelGateway.js',
  'src/ai/providers/ollamaProvider.js',
  'src/ai/telemetry.js',
  'src/controllers/resumeController.js',
  'src/models/Resume.js',
  'src/services/categoryBlueprintService.js',
  'src/services/answerEvaluationService.js',
  'src/services/contextBuilder.js',
  'src/services/interviewPlannerService.js',
  'src/services/questionCategories.js',
  'src/services/questionGeneratorService.js',
  'src/services/questionQualityService.js',
  'src/services/questionRotationService.js',
  'src/services/questionValidatorService.js',
  'src/services/skillAssessmentPlanner.js',
  'src/services/ollamaService.js',
  'test/aiGateway.test.js',
  'test/benchmarkAI.test.js',
  'test/adaptiveGeneration.test.js',
  'test/categoryApi.test.js',
  'test/categoryQuestions.test.js',
  'test/interviewPlanner.test.js',
  'test/mongoCheckpoint.test.js',
  'test/questionGenerator.test.js',
  'test/showTechnicalGeneration.js',
  'test/uiNavigation.test.js',
];

test('changed JavaScript sources parse without syntax errors', () => {
  for (const relativePath of sources) {
    const absolutePath = path.resolve(__dirname, '..', relativePath);
    const source = fs.readFileSync(absolutePath, 'utf8');
    assert.doesNotThrow(() => new vm.Script(source, { filename: relativePath }), relativePath);
  }
});
