const path = require('path');

// Keep existing installations in server/ unless an isolated data directory is configured.
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..'));
const DB_PATH = path.join(DATA_DIR, 'data.db');
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');

module.exports = { DATA_DIR, DB_PATH, UPLOADS_DIR };
