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

    assert.ok(summary.filesProcessed >= 3, `expected >=3 files, got ${summary.filesProcessed}`);
    assert.ok(summary.chunksWritten > 0, 'should have written chunks');
    assert.equal(summary.truncated, false);
  });

  await t.test('honors .indexignore — ignored files are not in the index', async () => {
    // build_output/ and docs/private/ are excluded by the fixture's .indexignore.
    // Searching for text that appears ONLY in those files must not surface them.
    const { stdout } = await run('search', 'excluded fixture marker must not be indexed', '-k', '5');

    assert.ok(
      !stdout.includes('build_output'),
      `ignored build_output/ leaked into the index:\n${stdout}`,
    );
    assert.ok(
      !stdout.includes('private'),
      `ignored docs/private/ leaked into the index:\n${stdout}`,
    );
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
    assert.ok(summary.filesSkipped >= 3, 'unchanged files should be counted as skipped');
    assert.equal(summary.chunksWritten, 0);
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
