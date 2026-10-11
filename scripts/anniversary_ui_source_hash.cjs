const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
module.exports = function fingerprint() {
  const index = process.argv.indexOf('--source');
  const root = path.resolve(index < 0 ? path.join(__dirname, '..') : process.argv[index + 1]);
  const hashes = {};
  function walk(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (/\.(html|js|css)$/.test(entry.name)) hashes[path.relative(root, file).replaceAll(path.sep, '/')] = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    }
  }
  walk(path.join(root, 'frontend'));
  return hashes;
};
