#!/usr/bin/env node
'use strict';

// Check prerequisites without importing the app, opening its database or creating data.
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 13)) {
  console.error('Node.js >=22.13.0 is required; found ' + process.version);
  process.exit(1);
}
console.log('Node.js ' + process.version);

(async () => {
  for (const name of ['server', 'client']) {
    if (!process.argv.includes('--' + name)) continue;
    const packageFile = path.join(__dirname, '..', name, 'package.json');
    const manifest = JSON.parse(fs.readFileSync(packageFile, 'utf8'));
    const fromPackage = createRequire(packageFile);
    const dependencies = { ...manifest.dependencies, ...(name === 'client' ? manifest.devDependencies : {}) };
    for (const dependency of Object.keys(dependencies)) {
      try { fromPackage.resolve(dependency); } catch {
        throw new Error(name + ' dependency is missing: ' + dependency + '. Run npm ci --include=optional' +
          (name === 'client' ? ' --include=dev' : ' --omit=dev') + ' in ' + name + '.');
      }
    }
    console.log(name + ' dependencies resolve OK');
    if (name === 'server') {
      let coordination;
      try {
        const { DatabaseSync } = require('node:sqlite');
        coordination = new DatabaseSync(':memory:');
        coordination.exec('BEGIN EXCLUSIVE; ROLLBACK');
        console.log('node:sqlite coordination capability OK');
      } catch (error) {
        throw new Error('Node.js with node:sqlite support is required for the data-directory lock: ' + error.message);
      } finally { coordination?.close(); }
    }
  }
  if (process.argv.includes('--sharp')) {
    const sharp = require(path.join(__dirname, '..', 'server', 'node_modules', 'sharp'));
    const png = await sharp({ create: { width: 1, height: 1, channels: 3, background: '#ffffff' } }).png().toBuffer();
    const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
    if (info.width !== 1 || info.height !== 1 || data.length !== 3) throw new Error('Unexpected decoded image');
    console.log('sharp native encode/decode OK');
  }
})().catch(error => {
  console.error('Runtime check failed: ' + error.message);
  console.error('Install dependencies on the target OS/architecture. Do not copy node_modules between platforms.');
  process.exitCode = 1;
});
