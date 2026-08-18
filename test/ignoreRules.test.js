import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadIgnore, makeIgnoreFilter } from '../src/ignoreRules.js';

function corpus() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ss-ignore-')));
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.mkdirSync(path.join(root, 'node_modules', 'dep'), { recursive: true });
  fs.mkdirSync(path.join(root, 'secrets'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'app.js'), 'ok');
  fs.writeFileSync(path.join(root, 'node_modules', 'dep', 'creds.json'), 'token');
  fs.writeFileSync(path.join(root, 'secrets', 'keys.json'), 'token');
  return root;
}

test('built-in default patterns are applied without any .indexignore', async () => {
  const ig = loadIgnore(corpus());
  assert.equal(ig.ignores('node_modules/dep/creds.json'), true);
  assert.equal(ig.ignores('.git/config'), true);
  assert.equal(ig.ignores('package-lock.json'), true);
  assert.equal(ig.ignores('src/app.js'), false);
});

test('a per-root .indexignore adds to the defaults', async () => {
  const root = corpus();
  fs.writeFileSync(path.join(root, '.indexignore'), 'secrets/\n');

  const ig = loadIgnore(root);
  assert.equal(ig.ignores('secrets/keys.json'), true, 'per-root pattern applied');
  assert.equal(ig.ignores('node_modules/dep/creds.json'), true, 'defaults still applied');
  assert.equal(ig.ignores('src/app.js'), false);
});

test('makeIgnoreFilter takes absolute paths and honors per-root rules', async () => {
  const rootA = corpus();
  const rootB = corpus();
  fs.writeFileSync(path.join(rootA, '.indexignore'), 'secrets/\n');
  // rootB deliberately has no .indexignore, so its secrets/ stays visible —
  // proving rules are scoped per root rather than pooled globally.

  const isIgnored = makeIgnoreFilter([rootA, rootB]);

  assert.equal(isIgnored(path.join(rootA, 'secrets', 'keys.json')), true);
  assert.equal(isIgnored(path.join(rootB, 'secrets', 'keys.json')), false);
  assert.equal(isIgnored(path.join(rootA, 'src', 'app.js')), false);
  assert.equal(isIgnored(path.join(rootB, 'node_modules', 'dep', 'creds.json')), true);
});

test('paths outside every configured root are treated as ignored', async () => {
  const isIgnored = makeIgnoreFilter([corpus()]);

  assert.equal(isIgnored('/etc/passwd'), true);
  assert.equal(isIgnored(path.join(os.homedir(), '.ssh', 'id_rsa')), true);
});

test('a sibling directory sharing a root name prefix is not treated as inside it', async () => {
  // Guards the `root + path.sep` boundary: /srv/data must not match /srv/data-private.
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ss-prefix-')));
  const root = path.join(base, 'data');
  const sibling = path.join(base, 'data-private');
  fs.mkdirSync(root);
  fs.mkdirSync(sibling);

  const isIgnored = makeIgnoreFilter([root]);

  assert.equal(isIgnored(path.join(root, 'notes.md')), false);
  assert.equal(isIgnored(path.join(sibling, 'notes.md')), true, 'prefix sibling must be excluded');
});
