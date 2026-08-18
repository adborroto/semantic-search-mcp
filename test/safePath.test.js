import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveWithinRoots } from '../src/safePath.js';

/**
 * These are access-control tests for the MCP `cat_file` tool. Before this check
 * existed, `cat_file` read any absolute path it was handed, so a client — or text
 * injected into an indexed file — could read arbitrary files off the machine.
 */

function sandbox() {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ss-safe-')));
  const root = path.join(base, 'repo');
  const outside = path.join(base, 'outside');
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'app.js'), 'inside the root');
  fs.writeFileSync(path.join(outside, 'id_rsa'), 'PRIVATE KEY');
  return { base, root, outside };
}

test('allows a file inside a configured root', async () => {
  const { root } = sandbox();
  const target = path.join(root, 'src', 'app.js');

  assert.equal(await resolveWithinRoots(target, [root]), target);
});

test('allows the root directory itself', async () => {
  const { root } = sandbox();
  assert.equal(await resolveWithinRoots(root, [root]), root);
});

test('refuses a file outside every configured root', async () => {
  const { root, outside } = sandbox();

  assert.equal(await resolveWithinRoots(path.join(outside, 'id_rsa'), [root]), null);
  assert.equal(await resolveWithinRoots('/etc/passwd', [root]), null);
});

test('refuses traversal out of a root via ..', async () => {
  const { root } = sandbox();
  const traversal = path.join(root, '..', 'outside', 'id_rsa');
  assert.equal(await resolveWithinRoots(traversal, [root]), null);
});

test('refuses a symlink inside a root that points outside it', async () => {
  const { root, outside } = sandbox();
  const link = path.join(root, 'src', 'leak.js');
  fs.symlinkSync(path.join(outside, 'id_rsa'), link);

  // The path *looks* like it is inside the root; only realpath reveals otherwise.
  assert.ok(link.startsWith(root + path.sep), 'precondition: link path is under the root');
  assert.equal(await resolveWithinRoots(link, [root]), null, 'symlink escape must be refused');
});

test('follows a symlink that stays inside the root', async () => {
  const { root } = sandbox();
  const real = path.join(root, 'src', 'app.js');
  const link = path.join(root, 'alias.js');
  fs.symlinkSync(real, link);

  assert.equal(await resolveWithinRoots(link, [root]), real);
});

test('does not treat a name-prefix sibling as inside the root', async () => {
  // /srv/data must not authorize /srv/data-private.
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ss-prefix-')));
  const root = path.join(base, 'data');
  const sibling = path.join(base, 'data-private');
  fs.mkdirSync(root);
  fs.mkdirSync(sibling);
  fs.writeFileSync(path.join(sibling, 'secret.txt'), 'nope');

  assert.equal(await resolveWithinRoots(path.join(sibling, 'secret.txt'), [root]), null);
});

test('refuses everything when no roots are configured', async () => {
  const { root } = sandbox();
  assert.equal(await resolveWithinRoots(path.join(root, 'src', 'app.js'), []), null);
});

test('a nonexistent path is refused rather than throwing', async () => {
  const { root } = sandbox();
  assert.equal(await resolveWithinRoots(path.join(root, 'no', 'such', 'file'), [root]), null);
});

test('a configured root that no longer exists grants no access', async () => {
  const { root } = sandbox();
  const target = path.join(root, 'src', 'app.js');

  assert.equal(await resolveWithinRoots(target, ['/definitely/not/here']), null);
  // ...and a stale root alongside a valid one must not break the valid one.
  assert.equal(await resolveWithinRoots(target, ['/definitely/not/here', root]), target);
});

test('picks the matching root when several are configured', async () => {
  const a = sandbox();
  const b = sandbox();
  const target = path.join(b.root, 'src', 'app.js');

  assert.equal(await resolveWithinRoots(target, [a.root, b.root]), target);
});
