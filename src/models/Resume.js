const mongoose = require('mongoose');
const { Schema } = mongoose;
const nested = (fields) => new Schema(fields, { _id: false });

const projectFields = {
  title: String,
  description: String,
  technologies: [String],
};
const educationSchema = nested({ degree: String, institution: String, year: String });
const evidenceItemSchema = nested({ id: String, name: String });
const evidenceProjectSchema = nested({ id: String, ...projectFields, duration: String });
const evidenceExperienceSchema = nested({ id: String, role: String, organisation: String, duration: String, responsibilities: [String] });
const structuredEvidenceSchema = nested({
  targetRole: nested({ id: String, value: String }),
  requiredSkillset: [evidenceItemSchema],
  skills: [evidenceItemSchema],
  projects: [evidenceProjectSchema],
  experience: [evidenceExperienceSchema],
  education: [nested({ id: String, degree: String, institution: String, year: String })],
  certifications: [evidenceItemSchema],
});
const parsedResumeSchema = nested({
  contact: nested({ name: String, email: String, phone: String }),
  skills: [String],
  projects: [nested({ ...projectFields, duration: String })],
  experience: [nested({
    role: String,
    organisation: String,
    duration: String,
    responsibilities: [String],
  })],
  education: [educationSchema],
  certifications: [String],
  meta: nested({
    sectionsDetected: [String],
    warnings: [String],
    rawTextLength: Number,
  }),
});
const analysisSchema = nested({
  summary: String,
  strengths: [String],
  skillAreasToProbe: [String],
  source: String,
});
const contextSchema = nested({
  skills: [String],
  projects: [nested(projectFields)],
  experience: [nested({
    role: String,
    organisation: String,
    duration: String,
    responsibilities: [String],
  })],
  experienceSummary: String,
  education: [educationSchema],
  certifications: [String],
  candidateSummary: String,
  strengths: [String],
  skillAreasToProbe: [String],
  interviewType: String,
  targetRole: String,
  requiredSkillset: [String],
  analysisSource: String,
  structuredEvidence: structuredEvidenceSchema,
});

const resumeSchema = new Schema({
  userId: { type: Schema.Types.ObjectId, required: true },
  file: {
    type: nested({
      originalName: { type: String, required: true },
      mimeType: { type: String, required: true },
      sizeBytes: { type: Number, required: true, min: 0 },
    }),
    required: true,
  },
  pageCount: { type: Number, required: true, min: 1 },
  parsedResume: { type: parsedResumeSchema, required: true },
  analysis: { type: analysisSchema, required: true },
  resumeContext: { type: contextSchema, required: true },
  // Practice data is keyed by category so generated sets, candidate answers,
  // and Ollama evaluations survive navigation and browser reloads.
  practice: { type: Schema.Types.Mixed, default: () => ({ categories: {} }) },
}, { timestamps: true, bufferCommands: false });

resumeSchema.index({ userId: 1, createdAt: -1 });

module.exports = mongoose.model('Resume', resumeSchema);
