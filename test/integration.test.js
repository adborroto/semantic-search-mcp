import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);

const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.join(here, '..', 'src', 'index.js');
const corpus = path.join(here, 'fixtures', 'corpus');

/**
 * End-to-end: index the fixture corpus into a throwaway directory, then query it.
 *
 * This is the only test that loads the real embedding model, so it downloads
 * ~25MB on a cold cache and is slow. Set SS_SKIP_INTEGRATION=1 to skip it.
 * State goes to a temp SS_INDEX_DIR so a developer's real index is never touched.
 */
const skip = process.env.SS_SKIP_INTEGRATION === '1'
  ? 'SS_SKIP_INTEGRATION=1'
  : false;

let indexDir;
let env;

test('index + search end to end', { skip, timeout: 600_000 }, async (t) => {
  indexDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-e2e-'));
  // Model cache is deliberately outside indexDir and stable across runs, so a
  // developer re-running the suite doesn't re-download the model each time.
  const modelCache = path.join(os.tmpdir(), 'ss-test-model-cache');

  env = {
    ...process.env,
    SS_INDEX_DIR: indexDir,
    SS_MODEL_CACHE_DIR: modelCache,
    SS_CONFIG_PATH: path.join(indexDir, 'no-config.json'), // force built-in defaults
  };

  const run = (...args) => execFileAsync(process.execPath, [cli, ...args], {
    env,
    maxBuffer: 20 * 1024 * 1024,
  });

  await t.test('indexes the corpus and reports what it did', async () => {
    const { stdout } = await run('index', corpus);
    const summary = JSON.parse(stdout.trimEnd().split('\n').at(-1));

    assert.ok(summary.filesProcessed >= 5, `expected >=5 files, got ${summary.filesProcessed}`);
    assert.ok(summary.chunksWritten > 0, 'should have written chunks');
    assert.equal(summary.truncated, false);
  });

  await t.test('honors .indexignore — ignored files are not in the index', async () => {
    // build_output/ and docs/private/ are excluded by the fixture's .indexignore.
    // Searching for text that appears ONLY in those files must not surface them.
    // Asserting on file paths rather than bare words matters: `.indexignore` is
    // itself an indexable text file, so its own patterns show up as result text.
    const { stdout } = await run('search', 'excluded fixture marker must not be indexed', '-k', '5');

    assert.ok(
      !stdout.includes('build_output/generated.json'),
      `ignored build_output/ leaked into the index:\n${stdout}`,
    );
    assert.ok(
      !stdout.includes('private/secret.md'),
      `ignored docs/private/ leaked into the index:\n${stdout}`,
    );
  });

  await t.test('indexes every language in the corpus, not an allow-list of extensions', async () => {
    // Regression: extensions used to be allow-listed (.js/.md/.py/.rb/.ts/.json only),
    // so a Flutter or Kotlin repo was indexed as if it contained no source code at all.
    const dart = await run('search', 'charging a card during checkout', '-k', '5');
    assert.ok(dart.stdout.includes('payment_service.dart'), `.dart not indexed:\n${dart.stdout}`);

    const kotlin = await run('search', 'following another account is idempotent', '-k', '5');
    assert.ok(kotlin.stdout.includes('Registration.kt'), `.kt not indexed:\n${kotlin.stdout}`);
  });

  await t.test('binary files are not indexed', async () => {
    const { stdout } = await run('search', 'fake png bytes', '-k', '5');
    assert.ok(!stdout.includes('logo.png'), `binary file leaked into the index:\n${stdout}`);
  });

  await t.test('an exact identifier is retrievable — the lexical arm of hybrid search', async () => {
    // ERR_ZORBLATT_7741 is a made-up token with no semantic neighbourhood; BM25 is
    // what finds it, and the fused ranking has to keep it on top.
    const { stdout } = await run('search', 'ERR_ZORBLATT_7741', '-k', '3');
    assert.ok(stdout.includes('payment_service.dart'), `exact term not retrieved:\n${stdout}`);
  });

  await t.test('finds the semantically relevant file for a paraphrased query', async () => {
    // Deliberately avoids the words "retry"/"backoff" so this exercises embedding
    // similarity rather than the lexical boost.
    const { stdout } = await run(
      'search', 'what happens when a payment request keeps failing', '-k', '3',
    );

    assert.ok(stdout.includes('retry.md'), `expected retry.md in results:\n${stdout}`);
  });

  await t.test('a second index run is incremental — nothing reprocessed', async () => {
    const { stdout } = await run('index', corpus);
    const summary = JSON.parse(stdout.trimEnd().split('\n').at(-1));

    assert.equal(summary.filesProcessed, 0, 'unchanged files must not be reprocessed');
    assert.ok(summary.filesSkipped >= 5, 'unchanged files should be counted as skipped');
    assert.equal(summary.chunksWritten, 0);
  });

  await t.test('removing a folder purges its chunks from the index', async () => {
    // Regression: `index` only prunes under the root it walks, so a folder dropped
    // from the config was never revisited and its chunks — verbatim text — kept
    // surfacing in search results forever. `remove` now purges by default.
    const extra = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-e2e-extra-'));
    fs.writeFileSync(
      path.join(extra, 'confidential.md'),
      'The zorblatt migration schedule is internal and must not be shared.',
    );

    await run('add', extra);
    await run('index');

    const before = await run('search', 'zorblatt migration schedule', '-k', '3');
    assert.ok(before.stdout.includes('confidential.md'), 'precondition: content is searchable');

    await run('remove', extra);

    const after = await run('search', 'zorblatt migration schedule', '-k', '3');
    assert.ok(
      !after.stdout.includes('confidential.md'),
      `removed folder's content is still searchable:\n${after.stdout}`,
    );

    fs.rmSync(extra, { recursive: true, force: true });
  });

  await t.test('state landed in SS_INDEX_DIR', async () => {
    // The complementary assertion — that the default index dir is never inside
    // the package directory — is covered in config.test.js without needing a run.
    assert.ok(fs.existsSync(indexDir), 'index dir should exist');
    assert.ok(fs.readdirSync(indexDir).length > 0, 'index dir should be populated');
  });

  t.after(() => {
    if (indexDir) fs.rmSync(indexDir, { recursive: true, force: true });
  });
});
