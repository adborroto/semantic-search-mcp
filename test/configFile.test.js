import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { addRoots, removeRoots, readRoots } from '../src/configFile.js';

function scratch() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ss-cfgfile-')));
  const projects = ['proj-a', 'proj-b'].map(name => {
    const p = path.join(dir, name);
    fs.mkdirSync(p);
    return p;
  });
  return { dir, configFile: path.join(dir, 'config.json'), projects };
}

test('add creates the config file when none exists', async () => {
  const { configFile, projects } = scratch();

  assert.equal(fs.existsSync(configFile), false, 'precondition: no config yet');

  const result = addRoots([projects[0]], configFile);

  assert.deepEqual(result.added, [projects[0]]);
  assert.ok(fs.existsSync(configFile), 'config file should be created on demand');
  assert.deepEqual(JSON.parse(fs.readFileSync(configFile, 'utf-8')).defaultRoots, [projects[0]]);
});

test('add is idempotent — re-adding reports "already", not a duplicate', async () => {
  const { configFile, projects } = scratch();

  addRoots([projects[0]], configFile);
  const second = addRoots([projects[0]], configFile);

  assert.deepEqual(second.added, []);
  assert.deepEqual(second.already, [projects[0]]);
  assert.deepEqual(second.roots, [projects[0]], 'must not be stored twice');
});

test('add rejects nonexistent paths and files, without writing them', async () => {
  const { dir, configFile, projects } = scratch();
  const aFile = path.join(dir, 'notes.md');
  fs.writeFileSync(aFile, 'not a directory');

  const result = addRoots([projects[0], aFile, path.join(dir, 'nope')], configFile);

  assert.deepEqual(result.added, [projects[0]]);
  assert.equal(result.missing.length, 2, 'a plain file and a missing path are both rejected');
  assert.deepEqual(result.roots, [projects[0]]);
});

test('add resolves relative paths and symlinks to one canonical entry', async () => {
  const { dir, configFile, projects } = scratch();
  const link = path.join(dir, 'link-to-a');
  fs.symlinkSync(projects[0], link);

  addRoots([projects[0]], configFile);
  const viaLink = addRoots([link], configFile);

  assert.deepEqual(viaLink.added, [], 'same directory via symlink must not be added twice');
  assert.deepEqual(viaLink.roots, [projects[0]]);
});

test('add preserves unrelated keys and hand-edits', async () => {
  const { configFile, projects } = scratch();
  fs.writeFileSync(configFile, JSON.stringify({
    defaultTopK: 9,
    chunk: { targetTokens: 300 },
    storeBackend: 'sqlite',
  }));

  addRoots([projects[0]], configFile);

  const written = JSON.parse(fs.readFileSync(configFile, 'utf-8'));
  assert.equal(written.defaultTopK, 9);
  assert.equal(written.storeBackend, 'sqlite');
  assert.deepEqual(written.chunk, { targetTokens: 300 });
  assert.deepEqual(written.defaultRoots, [projects[0]]);
});

test('add migrates a legacy singular defaultRoot into the array', async () => {
  const { configFile, projects } = scratch();
  fs.writeFileSync(configFile, JSON.stringify({ defaultRoot: projects[0] }));

  addRoots([projects[1]], configFile);

  const written = JSON.parse(fs.readFileSync(configFile, 'utf-8'));
  assert.deepEqual(written.defaultRoots, [projects[0], projects[1]]);
  assert.equal('defaultRoot' in written, false, 'legacy key should be collapsed away');
});

test('remove takes a bare folder name, not just a full path', async () => {
  const { configFile, projects } = scratch();
  addRoots(projects, configFile);

  const result = removeRoots(['proj-a'], configFile);

  assert.deepEqual(result.removed, [projects[0]]);
  assert.deepEqual(result.roots, [projects[1]]);
});

test('remove takes a full path too', async () => {
  const { configFile, projects } = scratch();
  addRoots(projects, configFile);

  const result = removeRoots([projects[1]], configFile);

  assert.deepEqual(result.removed, [projects[1]]);
  assert.deepEqual(result.roots, [projects[0]]);
});

test('remove reports unknown targets and leaves the config alone', async () => {
  const { configFile, projects } = scratch();
  addRoots([projects[0]], configFile);

  const result = removeRoots(['not-configured'], configFile);

  assert.deepEqual(result.removed, []);
  assert.deepEqual(result.notFound, ['not-configured']);
  assert.deepEqual(result.roots, [projects[0]]);
});

test('readRoots resolves relative entries against the config file directory', async () => {
  const { dir, configFile } = scratch();
  fs.writeFileSync(configFile, JSON.stringify({ defaultRoots: ['./proj-a', '../elsewhere'] }));


  assert.deepEqual(readRoots(configFile), [
    path.join(dir, 'proj-a'),
    path.resolve(dir, '..', 'elsewhere'),
  ]);
});

test('a removed root can be added back', async () => {
  const { configFile, projects } = scratch();

  addRoots(projects, configFile);
  removeRoots(['proj-a'], configFile);
  const again = addRoots([projects[0]], configFile);

  assert.deepEqual(again.added, [projects[0]]);
  assert.equal(again.roots.length, 2);
});
