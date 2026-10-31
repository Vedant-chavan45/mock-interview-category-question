const mongoose = require('mongoose');

async function connectDatabase() {
  const uri = process.env.MONGODB_URI;
  if (!uri || !uri.trim()) {
    throw new Error('MONGODB_URI must be configured.');
  }
  try {
    await mongoose.connect(uri, {
      dbName: process.env.MONGODB_DB_NAME || 'mock_interview_platform',
      serverSelectionTimeoutMS: 10000,
    });
  } catch {
    // Driver errors can contain connection details; never log the raw error.
    await mongoose.disconnect().catch(() => {});
    throw new Error('MongoDB connection failed. Check database configuration and network access.');
  }
}

function getDatabaseState() {
  return ['disconnected', 'connected', 'connecting', 'disconnecting'][mongoose.connection.readyState] || 'unknown';
}

module.exports = { connectDatabase, getDatabaseState };
