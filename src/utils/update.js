const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { execSync } = require('child_process');
const config = require('../config');

const PACKAGE_JSON = path.resolve('package.json');
const BACKUP_DIR = path.resolve('.rollback');
const TEMP_DIR = path.resolve('.update-tmp');

let _pkgVersion = null;
function getCurrentVersion() {
  if (_pkgVersion) return _pkgVersion;
  try {
    _pkgVersion = JSON.parse(fs.readFileSync(PACKAGE_JSON, 'utf8')).version || '0.0.0';
  } catch { _pkgVersion = '0.0.0'; }
  return _pkgVersion;
}

function compareVersions(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const na = pa[i] || 0, nb = pb[i] || 0;
    if (na > nb) return 1;
    if (na < nb) return -1;
  }
  return 0;
}

function _httpRequest(url, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { timeout }, (res) => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(data);
        else reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
  });
}

async function checkForUpdate() {
  const updateUrl = config.get('UPDATE_URL');
  if (!updateUrl) return null;
  const checkUrl = `${updateUrl.replace(/\/+$/, '')}/check`;
  try {
    const body = await _httpRequest(checkUrl);
    const meta = JSON.parse(body);
    if (!meta || !meta.latestVersion) return null;
    const current = getCurrentVersion();
    if (compareVersions(meta.latestVersion, current) <= 0) return null;
    return {
      latestVersion: meta.latestVersion,
      downloadUrl: meta.downloadUrl || `${updateUrl.replace(/\/+$/, '')}/download/${meta.latestVersion}`,
      changelog: meta.changelog || '',
      releaseDate: meta.releaseDate || '',
      size: meta.size || 0
    };
  } catch { return null; }
}

async function downloadUpdate(version, downloadUrl) {
  if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });
  const dest = path.join(TEMP_DIR, `noelle-${version}.zip`);
  if (fs.existsSync(dest)) return dest;
  try {
    const data = await _httpRequest(downloadUrl, 120000);
    fs.writeFileSync(dest, data);
    return dest;
  } catch (e) { throw new Error(`Download failed: ${e.message}`); }
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function applyUpdate(version, zipPath) {
  if (!fs.existsSync(zipPath)) throw new Error(`Update package not found: ${zipPath}`);

  ensureDir(BACKUP_DIR);
  const backupPath = path.join(BACKUP_DIR, `v${getCurrentVersion()}`);
  if (!fs.existsSync(backupPath)) {
    fs.mkdirSync(backupPath, { recursive: true });
    _backupDir('src', path.join(backupPath, 'src'));
    _backupDir('web', path.join(backupPath, 'web'));
    _backupDir('scripts', path.join(backupPath, 'scripts'));
    ['package.json', 'noelle.js', 'AI.PROMPT', '.noll-env'].forEach(f => {
      const src = path.resolve(f);
      if (fs.existsSync(src)) fs.copyFileSync(src, path.join(backupPath, f));
    });
  }

  const { execSync } = require('child_process');
  const extractDir = path.join(TEMP_DIR, `extracted-${version}`);
  if (fs.existsSync(extractDir)) fs.rmSync(extractDir, { recursive: true });
  ensureDir(extractDir);

  try {
    if (process.platform === 'win32') {
      execSync(`powershell -NoProfile -Command "Expand-Archive -Path '${zipPath}' -DestinationPath '${extractDir}' -Force"`, { stdio: 'pipe' });
    } else {
      execSync(`unzip -o '${zipPath}' -d '${extractDir}'`, { stdio: 'pipe' });
    }
  } catch {
    try {
      const AdmZip = require('adm-zip');
      const zip = new AdmZip(zipPath);
      zip.extractAllTo(extractDir, true);
    } catch (e2) {
      throw new Error(`Extraction failed: ${e2.message}`);
    }
  }

  const entries = fs.readdirSync(extractDir);
  const topDir = entries.length === 1 && fs.statSync(path.join(extractDir, entries[0])).isDirectory()
    ? path.join(extractDir, entries[0])
    : extractDir;

  const excluded = ['.rollback', '.update-tmp', 'node_modules', 'conversations', 'think_logs', '.noll-env', 'profile.json'];
  _copyDir(topDir, path.resolve('.'), excluded);

  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(topDir, 'package.json'), 'utf8'));
    if (pkg.dependencies) {
      console.log('  Instalando dependencias...');
      execSync('npm install --production', { stdio: 'inherit', cwd: path.resolve('.') });
    }
  } catch {}

  _cleanupTemp();

  return true;
}

function rollback() {
  const current = getCurrentVersion();
  const backupPath = path.join(BACKUP_DIR, `v${current}`);
  if (!fs.existsSync(backupPath)) throw new Error(`No rollback found for v${current}`);

  _copyDir(path.join(backupPath, 'src'), path.resolve('src'), []);
  _copyDir(path.join(backupPath, 'web'), path.resolve('web'), []);
  _copyDir(path.join(backupPath, 'scripts'), path.resolve('scripts'), []);

  const pkg = path.resolve('package.json');
  const bak = path.join(backupPath, 'package.json');
  if (fs.existsSync(bak)) fs.copyFileSync(bak, pkg);

  fs.rmSync(backupPath, { recursive: true });
  return true;
}

function _backupDir(src, dest) {
  if (!fs.existsSync(src)) return;
  const entries = fs.readdirSync(src, { withFileTypes: true });
  ensureDir(dest);
  for (const e of entries) {
    const s = path.join(src, e.name);
    const d = path.join(dest, e.name);
    if (e.name === 'node_modules') continue;
    if (e.isDirectory()) _backupDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

function _copyDir(src, dest, excluded) {
  if (!fs.existsSync(src)) return;
  const entries = fs.readdirSync(src, { withFileTypes: true });
  ensureDir(dest);
  for (const e of entries) {
    if (excluded.includes(e.name)) continue;
    const s = path.join(src, e.name);
    const d = path.join(dest, e.name);
    if (e.isDirectory()) {
      _copyDir(s, d, excluded);
    } else {
      try { fs.copyFileSync(s, d); } catch {}
    }
  }
}

function _cleanupTemp() {
  if (fs.existsSync(TEMP_DIR)) {
    try { fs.rmSync(TEMP_DIR, { recursive: true }); } catch {}
  }
}

function cleanOldRollbacks() {
  if (!fs.existsSync(BACKUP_DIR)) return;
  const dirs = fs.readdirSync(BACKUP_DIR);
  if (dirs.length > 1) {
    dirs.sort().slice(0, -1).forEach(d => {
      try { fs.rmSync(path.join(BACKUP_DIR, d), { recursive: true }); } catch {}
    });
  }
}

function getUpdateInfo() {
  const current = getCurrentVersion();
  const updateUrl = config.get('UPDATE_URL');
  return { currentVersion: current, updateUrl, autoUpdate: config.get('AUTO_UPDATE') };
}

module.exports = {
  checkForUpdate, downloadUpdate, applyUpdate,
  rollback, getCurrentVersion, compareVersions,
  getUpdateInfo, cleanOldRollbacks
};
