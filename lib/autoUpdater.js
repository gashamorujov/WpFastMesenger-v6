/**
 * Auto-updater — polls the GitHub repo every 5 minutes.
 * If a new commit is found:
 *   - git available → git pull + restart (VPS / bind-mounted Docker)
 *   - git NOT available (Railway) → logs guidance (Railway auto-deploys on push)
 */
const { execSync } = require('child_process');
const fs = require('fs-extra');
const path = require('path');

const REPO = 'gashamorujov/WpFastMesenger';
const BRANCH = 'main';
const CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const STATE_FILE = path.join(__dirname, '..', 'data', 'auto-update-state.json');

const LOG = {
  info: (...a) => console.log('[AutoUpdate]', ...a),
  error: (...a) => console.error('[AutoUpdate]', ...a),
};

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return {}; }
}

function saveState(state) {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(state)); } catch {}
}

function isGitRepo() {
  try {
    execSync('git rev-parse --is-inside-work-tree', { stdio: 'ignore' });
    return true;
  } catch { return false; }
}

function hasLocalChanges() {
  try {
    const out = execSync('git status --porcelain', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    return out.length > 0;
  } catch {
    return true; // can't tell — be safe
  }
}

function gitPull() {
  // Fetch latest and hard-reset local files
  execSync('git fetch origin', { stdio: 'inherit' });
  execSync(`git reset --hard origin/${BRANCH}`, { stdio: 'inherit' });

  // Reinstall deps only if package manifests changed
  const changed = execSync('git diff --name-only HEAD@{1} HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString();
  if (changed.includes('package.json') || changed.includes('package-lock.json')) {
    LOG.info('Dependencies changed — running npm install...');
    execSync('npm install --production', { stdio: 'inherit', timeout: 120000 });
  }
}

async function fetchRemoteSha() {
  const res = await fetch(`https://api.github.com/repos/${REPO}/commits/${BRANCH}`, {
    headers: { 'User-Agent': 'whatsapp-bulk-bot-autoupdater' },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) return null;
  const data = await res.json();
  return data.sha || null;
}

async function checkForUpdate() {
  try {
    const remoteSha = await fetchRemoteSha();
    if (!remoteSha) return;

    const state = loadState();

    // First run — record current version, don't restart
    if (!state.appliedSha) {
      state.appliedSha = remoteSha;
      saveState(state);
      LOG.info(`Current version: ${remoteSha.slice(0, 8)}`);
      return;
    }

    if (remoteSha === state.appliedSha) return; // up to date

    LOG.info(`New version detected: ${remoteSha.slice(0, 8)} (running ${state.appliedSha.slice(0, 8)})`);

    if (isGitRepo()) {
      if (hasLocalChanges()) {
        LOG.info('Local changes detected — skipping auto-update to avoid overwriting work.');
        return;
      }
      try {
        gitPull();
        state.appliedSha = remoteSha;
        saveState(state);
        LOG.info('Updated successfully. Restarting...');
        setTimeout(() => process.exit(0), 1000);
      } catch (e) {
        LOG.error('Update failed:', e.message);
      }
    } else {
      // Railway / baked image — Railway auto-deploys on GitHub push
      LOG.info('Git not available — Railway auto-deploy will pick up the new version.');
      state.appliedSha = remoteSha;
      saveState(state);
    }
  } catch (e) {
    LOG.error('Check failed:', e.message);
  }
}

function startAutoUpdate() {
  LOG.info('Auto-update started (checks every 5 min)');
  setTimeout(checkForUpdate, 15000); // first check after 15s (let bot boot first)
  setInterval(checkForUpdate, CHECK_INTERVAL_MS);
}

module.exports = { startAutoUpdate };
