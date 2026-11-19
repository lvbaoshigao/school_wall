#!/usr/bin/env node
'use strict';

// Check deployment prerequisites without importing the app or opening its database.
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 12)) {
  console.error('Node.js >=22.12.0 is required; found ' + process.version);
  process.exit(1);
}
console.log('Node.js ' + process.version);

if (process.argv.includes('--sharp')) {
  const path = require('node:path');
  (async () => {
    const sharp = require(path.join(__dirname, '..', 'server', 'node_modules', 'sharp'));
    const png = await sharp({ create: { width: 1, height: 1, channels: 3, background: '#ffffff' } }).png().toBuffer();
    const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
    if (info.width !== 1 || info.height !== 1 || data.length !== 3) throw new Error('Unexpected decoded image');
    console.log('sharp native encode/decode OK');
  })().catch(error => {
    console.error('sharp native check failed: ' + error.message);
    console.error('Run npm ci --include=optional in server on the target OS/architecture. Do not copy node_modules between platforms.');
    process.exitCode = 1;
  });
}
