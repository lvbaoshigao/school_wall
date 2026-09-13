const fs = require('fs');
const lock = JSON.parse(fs.readFileSync('package-lock.json', 'utf8'));
const want = ['node_modules/@vue/compiler-core', 'node_modules/@jridgewell/sourcemap-codec'];
const out = {};
for (const k of want) {
  const entry = lock.packages[k];
  if (entry) out[k.split('/').pop()] = entry.version;
}
fs.writeFileSync('pkg_versions.json', JSON.stringify(out, null, 2));
console.log(JSON.stringify(out));
