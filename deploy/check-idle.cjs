#!/usr/bin/env node
'use strict';

// Refuse dependency replacement while this checkout has live server/Vite entries.
const path = require('node:path');
const { assertDependenciesIdle } = require('./development.cjs');
try {
  if (process.platform !== 'linux') throw new Error('Linux /proc is required; use the Windows launcher on Windows.');
  const names = process.argv.includes('--backend-only') ? ['server'] : ['server', 'client'];
  for (const name of names) assertDependenciesIdle(path.resolve(__dirname, '..', name));
  console.log('No live application entries use the selected dependency directories.');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
