const fs = require('fs');
const { execSync } = require('child_process');

// Get Git commit hash
const version = execSync('git rev-parse --short HEAD').toString().trim();

// Read service worker
let serviceWorker = fs.readFileSync('sw.js', 'utf8');

// Replace version
serviceWorker = serviceWorker.replace(/CACHE_NAME = ['"]post-app-[^'"]+['"]/, `CACHE_NAME = 'post-app-${version}'`);

// Write service worker
fs.writeFileSync('sw.js', serviceWorker);

console.log(`Built service worker with version ${version}`);