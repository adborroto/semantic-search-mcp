import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { loadIgnore, listIndexableFiles, makeIgnoreFilter } from '../src/ignoreRules.js';

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

/** A git repo with a root-level and a nested .gitignore, plus one committed file. */
function gitCorpus() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ss-git-')));
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { stdio: 'pipe' });

  fs.mkdirSync(path.join(root, 'lib', 'generated'), { recursive: true });
  fs.mkdirSync(path.join(root, 'build'), { recursive: true });

  fs.writeFileSync(path.join(root, '.gitignore'), 'build/\n*.log\n');
  fs.writeFileSync(path.join(root, 'lib', 'generated', '.gitignore'), '*.g.dart\n!keep.g.dart\n');

  fs.writeFileSync(path.join(root, 'lib', 'service.dart'), 'class Service {}');
  fs.writeFileSync(path.join(root, 'lib', 'generated', 'model.g.dart'), 'generated');
  fs.writeFileSync(path.join(root, 'lib', 'generated', 'keep.g.dart'), 'kept on purpose');
  fs.writeFileSync(path.join(root, 'build', 'output.dart'), 'build output');
  fs.writeFileSync(path.join(root, 'debug.log'), 'noise');
  fs.writeFileSync(path.join(root, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00]));

  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'test');
  git('add', '-A');
  git('commit', '-qm', 'init');
  return root;
}

const relsOf = (root, files) => files.map((f) => path.relative(root, f)).sort();

test('built-in default patterns are applied without any .indexignore', async () => {
  const ig = loadIgnore(corpus());
  assert.equal(ig.ignores('node_modules/dep/creds.json'), true);
  assert.equal(ig.ignores('.git/config'), true);
  assert.equal(ig.ignores('src/app.js'), false);
});

test('lockfiles are indexable — git tracks them and the size cap handles the big ones', async () => {
  const ig = loadIgnore(corpus());
  assert.equal(ig.ignores('package-lock.json'), false);
  assert.equal(ig.ignores('Gemfile.lock'), false);
});

test('a per-root .indexignore adds to the defaults', async () => {
  const root = corpus();
  fs.writeFileSync(path.join(root, '.indexignore'), 'secrets/\n');

  const ig = loadIgnore(root);
  assert.equal(ig.ignores('secrets/keys.json'), true, 'per-root pattern applied');
  assert.equal(ig.ignores('node_modules/dep/creds.json'), true, 'defaults still applied');
  assert.equal(ig.ignores('src/app.js'), false);
});

test('a non-git folder is walked, and every extension is indexable', async () => {
  const root = corpus();
  fs.writeFileSync(path.join(root, 'main.dart'), 'void main() {}');
  fs.writeFileSync(path.join(root, 'Service.kt'), 'class Service');
  fs.writeFileSync(path.join(root, 'schema.sql'), 'select 1');
  fs.writeFileSync(path.join(root, 'notes.md'), 'notes');

  const files = relsOf(root, await listIndexableFiles(root));

  // The old allow-list indexed only .js/.md here — every other language was invisible.
  assert.deepEqual(files, ['Service.kt', 'main.dart', 'notes.md', 'schema.sql', 'secrets/keys.json', 'src/app.js']);
});

test('known-binary extensions are excluded', async () => {
  const root = corpus();
  fs.writeFileSync(path.join(root, 'icon.png'), Buffer.from([0x89, 0x50]));
  fs.writeFileSync(path.join(root, 'lib.jar'), Buffer.from([0x50, 0x4b]));
  fs.writeFileSync(path.join(root, 'font.woff2'), Buffer.from([0x77, 0x4f]));

  const files = relsOf(root, await listIndexableFiles(root));
  for (const binary of ['icon.png', 'lib.jar', 'font.woff2']) {
    assert.ok(!files.includes(binary), `${binary} should not be indexable`);
  }
});

test('a git repo honors .gitignore, including nested files and negations', async () => {
  const root = gitCorpus();
  const files = relsOf(root, await listIndexableFiles(root));

  assert.ok(files.includes(path.join('lib', 'service.dart')), 'tracked source is indexed');
  assert.ok(!files.includes(path.join('build', 'output.dart')), 'root .gitignore honored');
  assert.ok(!files.includes('debug.log'), 'root glob honored');
  assert.ok(
    !files.includes(path.join('lib', 'generated', 'model.g.dart')),
    'nested .gitignore honored — a flat root matcher could not do this',
  );
  assert.ok(
    files.includes(path.join('lib', 'generated', 'keep.g.dart')),
    'negation pattern honored',
  );
  assert.ok(!files.includes('logo.png'), 'committed binary still excluded');
});

test('untracked-but-not-ignored files are indexed', async () => {
  const root = gitCorpus();
  fs.writeFileSync(path.join(root, 'lib', 'draft.dart'), 'class Draft {}');
  fs.writeFileSync(path.join(root, 'skip.log'), 'ignored');

  const files = relsOf(root, await listIndexableFiles(root));
  assert.ok(files.includes(path.join('lib', 'draft.dart')), 'new uncommitted file is searchable');
  assert.ok(!files.includes('skip.log'), 'still gitignored');
});

test('.indexignore overrides git — committed but not searchable', async () => {
  const root = gitCorpus();
  fs.writeFileSync(path.join(root, '.indexignore'), 'lib/generated/\n');

  const files = relsOf(root, await listIndexableFiles(root));
  assert.ok(files.includes(path.join('lib', 'service.dart')));
  assert.ok(
    !files.includes(path.join('lib', 'generated', 'keep.g.dart')),
    '.indexignore applies on top of git rules',
  );
});

test('.git internals are never indexed', async () => {
  const root = gitCorpus();
  const files = await listIndexableFiles(root);
  assert.ok(!files.some((f) => f.includes(`${path.sep}.git${path.sep}`)), '.git/ must stay out');
});

test('makeIgnoreFilter takes absolute paths and honors per-root rules', async () => {
  const rootA = corpus();
  const rootB = corpus();
  fs.writeFileSync(path.join(rootA, '.indexignore'), 'secrets/\n');
  // rootB deliberately has no .indexignore, so its secrets/ stays visible —
  // proving rules are scoped per root rather than pooled globally.

  const isIgnored = await makeIgnoreFilter([rootA, rootB]);

  assert.equal(isIgnored(path.join(rootA, 'secrets', 'keys.json')), true);
  assert.equal(isIgnored(path.join(rootB, 'secrets', 'keys.json')), false);
  assert.equal(isIgnored(path.join(rootA, 'src', 'app.js')), false);
  assert.equal(isIgnored(path.join(rootB, 'node_modules', 'dep', 'creds.json')), true);
});

test('grep boundary matches the indexer exactly, gitignore included', async () => {
  const root = gitCorpus();
  const isIgnored = await makeIgnoreFilter([root]);

  assert.equal(isIgnored(path.join(root, 'lib', 'service.dart')), false);
  assert.equal(isIgnored(path.join(root, 'build', 'output.dart')), true);
  assert.equal(isIgnored(path.join(root, 'lib', 'generated', 'model.g.dart')), true);
});

test('paths outside every configured root are treated as ignored', async () => {
  const isIgnored = await makeIgnoreFilter([corpus()]);

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
  fs.writeFileSync(path.join(root, 'notes.md'), 'inside');
  fs.writeFileSync(path.join(sibling, 'notes.md'), 'outside');

  const isIgnored = await makeIgnoreFilter([root]);

  assert.equal(isIgnored(path.join(root, 'notes.md')), false);
  assert.equal(isIgnored(path.join(sibling, 'notes.md')), true, 'prefix sibling must be excluded');
});

test('symlinks are skipped rather than followed out of the root', async () => {
  const root = gitCorpus();
  const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ss-outside-')));
  fs.writeFileSync(path.join(outside, 'secret.md'), 'must not be indexed');
  fs.symlinkSync(path.join(outside, 'secret.md'), path.join(root, 'linked.md'));

  const files = relsOf(root, await listIndexableFiles(root));
  assert.ok(!files.includes('linked.md'), 'symlink must not be indexed');
});
