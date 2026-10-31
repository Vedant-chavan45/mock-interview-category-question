'use strict';

// Entirely synthetic test data. It does not represent a real candidate or resume.
const parsedResume = {
  skills: ['Node.js', 'Express', 'MongoDB', 'JWT', 'REST APIs'],
  projects: [
    {
      title: 'Synthetic Ticket Routing API',
      description: 'A sample academic service that accepted support tickets through REST endpoints, validated requests, and stored ticket state in MongoDB.',
      technologies: ['Node.js', 'Express', 'MongoDB', 'JWT'],
      duration: 'Synthetic project',
    },
    {
      title: 'Synthetic Inventory Service',
      description: 'A sample service that exposed inventory updates, checked request permissions, and returned consistent API errors.',
      technologies: ['Node.js', 'Express', 'MongoDB'],
      duration: 'Synthetic project',
    },
  ],
  experience: [{
    role: 'Backend Engineering Intern',
    organisation: 'Example Systems (Synthetic)',
    duration: 'Synthetic internship',
    responsibilities: [
      'Implemented REST endpoints and request validation for an internal sample service.',
      'Investigated MongoDB query issues and verified changes with repeatable checks.',
      'Coordinated API changes with a small synthetic project team.',
    ],
  }],
  education: [{ degree: 'Sample Computer Science Degree', institution: 'Example Institute (Synthetic)', year: '2026' }],
  certifications: ['Sample Backend Foundations Certificate'],
};

const analysis = {
  summary: 'Synthetic backend candidate data for local Ollama integration verification.',
  strengths: ['Synthetic API development', 'Synthetic data handling', 'Synthetic debugging'],
  skillAreasToProbe: ['Synthetic API design', 'Synthetic query performance', 'Synthetic reliability'],
  source: 'synthetic-fixture',
};

module.exports = { parsedResume, analysis, targetRole: 'Backend Developer', interviewType: 'Technical' };
