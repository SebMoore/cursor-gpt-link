import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

// Cursor's updater can replace every patched file while leaving our record.
// Only retire that record when the same targets match a reviewed pristine build.
export function verifySupersededInstallation(manifestPath, {root, build}) {
  if (!fs.existsSync(manifestPath)) return null;
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (manifest.version === build.version && manifest.commit === build.commit) {
    throw new Error('Installation already recorded for this Cursor build. Use status or restore first.');
  }
  const canonical = file => process.platform === 'win32' ? path.resolve(file).toLowerCase() : path.resolve(file);
  const targets = new Map(Object.entries(build.files).map(([relative, expected]) => [canonical(path.join(root, relative)), expected]));
  const recorded = new Set((manifest.files ?? []).map(file => canonical(file.path)));
  if (!targets.size || recorded.size !== targets.size || manifest.files.length !== targets.size ||
      [...recorded].some(file => !targets.has(file))) {
    throw new Error('Recorded installation targets differ from this Cursor installation; upgrade stopped.');
  }
  for (const [relative, expected] of Object.entries(build.files)) {
    const file = path.join(root, relative);
    if (!fs.existsSync(file) || hash(fs.readFileSync(file)) !== expected) {
      throw new Error('Current Cursor files are not the reviewed original build; upgrade stopped: ' + file);
    }
  }
  return manifest;
}

export function archiveSupersededInstallation(manifestPath, options) {
  if (!verifySupersededInstallation(manifestPath, options)) return null;
  const archived = manifestPath + '.superseded-' + Date.now() + '-' + crypto.randomUUID();
  fs.renameSync(manifestPath, archived);
  return archived;
}

export function installFiles(pending, {backupDir, manifestPath, version, commit}) {
  if (fs.existsSync(manifestPath)) throw new Error('An installation manifest already exists.');
  const manifest = {version, commit, installedAt:new Date().toISOString(), files:[]};
  for (let n = 0; n < pending.length; n++) {
    const file = pending[n];
    const backup = path.join(backupDir, n + '-' + path.basename(file.path));
    fs.copyFileSync(file.path, backup);
    manifest.files.push({path:file.path, backup, originalHash:hash(fs.readFileSync(backup)), patchedHash:hash(file.content)});
  }
  // Persist recovery information before any application file is written.
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), {flag:'wx'});
  try {
    for (const file of pending) fs.writeFileSync(file.path, file.content);
    for (const file of manifest.files) {
      if (hash(fs.readFileSync(file.path)) !== file.patchedHash) throw new Error('Post-write verification failed: ' + file.path);
    }
  } catch (error) {
    // Keep the manifest if rollback fails so recovery can be retried.
    for (const file of manifest.files) fs.copyFileSync(file.backup, file.path);
    fs.renameSync(manifestPath, manifestPath + '.rolled-back-' + Date.now());
    throw error;
  }
  return manifest;
}

export function restoreFiles(manifestPath) {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  // Check every file before writing any of them. Accept originals to allow
  // recovery after an interrupted installation or restoration.
  for (const file of manifest.files) {
    const current = hash(fs.readFileSync(file.path));
    if (current !== file.patchedHash && current !== file.originalHash) throw new Error('File changed since installation; restore stopped: ' + file.path);
    if (hash(fs.readFileSync(file.backup)) !== file.originalHash) throw new Error('Backup is damaged; restore stopped: ' + file.backup);
  }
  for (const file of manifest.files) fs.copyFileSync(file.backup, file.path);
  fs.renameSync(manifestPath, manifestPath + '.restored-' + Date.now());
}
