import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {installFiles, restoreFiles, hash, verifySupersededInstallation, archiveSupersededInstallation} from '../src/installation.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-gpt-link-install-test-'));
  t.after(() => fs.rmSync(root, {recursive:true, force:true}));
  const backupDir = path.join(root, 'backups');
  fs.mkdirSync(backupDir);
  const pending = ['one.js', 'two.js'].map((name, i) => {
    const file = path.join(root, name);
    fs.writeFileSync(file, 'original ' + i);
    return {path:file, content:'patched ' + i};
  });
  const options = {backupDir, manifestPath:path.join(root, 'installed.json'), version:'test', commit:'test'};
  return {pending, options};
}

test('installation and restore preserve exact original bytes', t => {
  const {pending, options} = fixture(t);
  installFiles(pending, options);
  assert.equal(fs.readFileSync(pending[0].path, 'utf8'), 'patched 0');
  assert.throws(() => installFiles(pending, options), /already exists/);
  restoreFiles(options.manifestPath);
  pending.forEach((file, i) => assert.equal(fs.readFileSync(file.path, 'utf8'), 'original ' + i));
  assert.equal(fs.existsSync(options.manifestPath), false);
});

test('restore refuses an updated application without changing other files', t => {
  const {pending, options} = fixture(t);
  installFiles(pending, options);
  fs.writeFileSync(pending[1].path, 'updated application');
  assert.throws(() => restoreFiles(options.manifestPath), /File changed/);
  assert.equal(fs.readFileSync(pending[0].path, 'utf8'), 'patched 0');
});

test('restore refuses damaged backups before changing the application', t => {
  const {pending, options} = fixture(t);
  const manifest = installFiles(pending, options);
  fs.writeFileSync(manifest.files[1].backup, 'damaged');
  assert.throws(() => restoreFiles(options.manifestPath), /Backup is damaged/);
  assert.equal(fs.readFileSync(pending[0].path, 'utf8'), 'patched 0');
});

test('restore can resume after an interrupted restoration', t => {
  const {pending, options} = fixture(t);
  const manifest = installFiles(pending, options);
  fs.copyFileSync(manifest.files[0].backup, pending[0].path);
  restoreFiles(options.manifestPath);
  assert.equal(fs.readFileSync(pending[1].path, 'utf8'), 'original 1');
});

function updatedFixture(t) {
  const fixtureData = fixture(t);
  const {pending, options} = fixtureData;
  const manifest = installFiles(pending, options);
  const root = path.dirname(pending[0].path);
  const build = {version:'updated', commit:'updated-commit', files:{}};
  for (const [index, file] of pending.entries()) {
    const bytes = 'updated original ' + index;
    fs.writeFileSync(file.path, bytes);
    build.files[path.basename(file.path)] = hash(bytes);
  }
  return {...fixtureData, manifest, upgrade:{root, build}};
}

test('a pristine Cursor update archives its record and can install and restore the new build', t => {
  const {pending, options, manifest, upgrade} = updatedFixture(t);
  const originalRecord = fs.readFileSync(options.manifestPath);
  assert.deepEqual(verifySupersededInstallation(options.manifestPath, upgrade), manifest);
  assert.deepEqual(fs.readFileSync(options.manifestPath), originalRecord, 'Preflight preserves the record');
  const archived = archiveSupersededInstallation(options.manifestPath, upgrade);
  assert.deepEqual(fs.readFileSync(archived), originalRecord);
  assert.equal(fs.existsSync(options.manifestPath), false);
  for (const [index, file] of manifest.files.entries()) {
    assert.equal(fs.readFileSync(file.backup, 'utf8'), 'original ' + index);
    assert.equal(fs.readFileSync(file.path, 'utf8'), 'updated original ' + index);
  }
  const backupDir = path.join(upgrade.root, 'updated-backups');
  fs.mkdirSync(backupDir);
  installFiles(pending, {...options, backupDir, version:upgrade.build.version, commit:upgrade.build.commit});
  restoreFiles(options.manifestPath);
  for (const [index, file] of pending.entries()) assert.equal(fs.readFileSync(file.path, 'utf8'), 'updated original ' + index);
  assert.deepEqual(fs.readFileSync(archived), originalRecord);
});

test('upgrade refuses a same-build record even with pristine application files', t => {
  const {options, upgrade} = updatedFixture(t);
  upgrade.build.version = options.version;
  upgrade.build.commit = options.commit;
  assert.throws(() => archiveSupersededInstallation(options.manifestPath, upgrade), /already recorded/);
  assert.ok(fs.existsSync(options.manifestPath));
});

for (const problem of ['modified', 'missing', 'different root', 'missing target', 'duplicate target']) {
  test('upgrade refuses ' + problem + ' without archiving the record or restoring old files', t => {
    const {pending, options, upgrade} = updatedFixture(t);
    if (problem === 'modified') fs.writeFileSync(pending[1].path, 'unknown file');
    if (problem === 'missing') fs.unlinkSync(pending[1].path);
    if (problem === 'different root') upgrade.root = path.join(upgrade.root, 'other-installation');
    if (problem === 'missing target') delete upgrade.build.files[path.basename(pending[1].path)];
    if (problem === 'duplicate target') {
      const manifest = JSON.parse(fs.readFileSync(options.manifestPath));
      manifest.files.push(manifest.files[0]);
      fs.writeFileSync(options.manifestPath, JSON.stringify(manifest));
    }
    assert.throws(() => archiveSupersededInstallation(options.manifestPath, upgrade), /upgrade stopped/);
    assert.ok(fs.existsSync(options.manifestPath));
    assert.equal(fs.readFileSync(pending[0].path, 'utf8'), 'updated original 0');
  });
}
