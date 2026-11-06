'use strict';

// Reuse the deterministic Ollama fixtures and print the exact seven-skill
// outputs produced by the adaptive-generation acceptance test.
process.env.PRINT_TECHNICAL_DEMO = '1';
require('./adaptiveGeneration.test');
