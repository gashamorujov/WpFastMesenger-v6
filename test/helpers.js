/**
 * Test helpers — isolate the persistent data directory per test file so
 * node --test (which runs each file in its own process, in parallel) never
 * races on the shared data/ directory.
 */
const os = require('os');
const path = require('path');
const fs = require('fs-extra');

function isolateDataDir(name) {
  const dir = path.join(os.tmpdir(), `wpfast-test-${name}-${process.pid}`);
  fs.ensureDirSync(dir);
  process.env.BOT_DATA_DIR = dir;
  return dir;
}

module.exports = { isolateDataDir };
