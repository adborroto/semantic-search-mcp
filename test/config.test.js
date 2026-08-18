import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * config.js reads the environment at import time, so each case needs a fresh
 * module instance. A cache-busting query string on the import URL gives us that
 * without a test-only hook in the source.
 */
let counter = 0;
async function loadConfig(env) {
  const saved = { ...process.env };
  for (const key of ['SS_CONFIG_PATH', 'SS_INDEX_DIR', 'SS_MODEL_CACHE_DIR', 'SS_STORE_BACKEND', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME']) {
    delete process.env[key];
  }
  Object.assign(process.env, env);
  try {
    return await import(`../src/config.js?case=${counter++}`);
  } finally {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, saved);
  }
}

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ss-config-'));
}

test('canonical config and data locations follow XDG, not the package directory', async () => {
  const home = tmpdir();
  const { config, configPath, configDir, dataDir } = await loadConfig({
    XDG_CONFIG_HOME: path.join(home, 'cfg'),
    XDG_DATA_HOME: path.join(home, 'data'),
  });

  assert.equal(configDir, path.join(home, 'cfg', 'semantic-search'));
  assert.equal(configPath, path.join(home, 'cfg', 'semantic-search', 'config.json'));
  assert.equal(dataDir, path.join(home, 'data', 'semantic-search'));
  assert.equal(config.indexDir, path.join(home, 'data', 'semantic-search'));
  assert.equal(config.modelCacheDir, path.join(home, 'data', 'semantic-search', 'models'));

  // The whole point of the XDG move: state must not live inside the install dir,
  // which under npx is a purgeable cache whose path changes on every version bump.
  assert.ok(
    !config.indexDir.startsWith(config.packageRoot),
    `indexDir ${config.indexDir} must not be inside packageRoot ${config.packageRoot}`,
  );
});

test('an existing XDG config outranks the in-checkout dev fallback', async () => {
  const home = tmpdir();
  const xdgDir = path.join(home, 'cfg', 'semantic-search');
  fs.mkdirSync(xdgDir, { recursive: true });
  fs.writeFileSync(path.join(xdgDir, 'config.json'), JSON.stringify({ defaultTopK: 11 }));

  const { config } = await loadConfig({ XDG_CONFIG_HOME: path.join(home, 'cfg') });

  assert.equal(config.configPath, path.join(xdgDir, 'config.json'));
  assert.equal(config.defaultTopK, 11);
});

test('SS_CONFIG_PATH overrides the XDG config location', async () => {
  const dir = tmpdir();
  const explicit = path.join(dir, 'my-config.json');
  fs.writeFileSync(explicit, JSON.stringify({ defaultTopK: 42 }));

  const { config } = await loadConfig({
    SS_CONFIG_PATH: explicit,
    XDG_CONFIG_HOME: path.join(dir, 'cfg'),
  });

  assert.equal(config.configPath, explicit);
  assert.equal(config.defaultTopK, 42);
});

test('SS_INDEX_DIR overrides config.json, and moves the model cache with it', async () => {
  const dir = tmpdir();
  const cfgFile = path.join(dir, 'c.json');
  fs.writeFileSync(cfgFile, JSON.stringify({ indexDir: path.join(dir, 'from-config') }));

  const { config } = await loadConfig({
    SS_CONFIG_PATH: cfgFile,
    SS_INDEX_DIR: path.join(dir, 'from-env'),
  });

  assert.equal(config.indexDir, path.join(dir, 'from-env'), 'env must win over config.json');
  assert.equal(config.modelCacheDir, path.join(dir, 'from-env', 'models'));
});

test('SS_MODEL_CACHE_DIR and SS_STORE_BACKEND are honored', async () => {
  const dir = tmpdir();
  const { config } = await loadConfig({
    SS_CONFIG_PATH: path.join(dir, 'missing.json'),
    SS_MODEL_CACHE_DIR: path.join(dir, 'models'),
    SS_STORE_BACKEND: 'sqlite',
  });

  assert.equal(config.modelCacheDir, path.join(dir, 'models'));
  assert.equal(config.storeBackend, 'sqlite');
});

test('chunk overrides merge one level deep instead of replacing the object', async () => {
  const dir = tmpdir();
  const cfgFile = path.join(dir, 'c.json');
  fs.writeFileSync(cfgFile, JSON.stringify({ chunk: { targetTokens: 300 } }));

  const { config } = await loadConfig({ SS_CONFIG_PATH: cfgFile });

  assert.equal(config.chunk.targetTokens, 300, 'override applied');
  assert.equal(config.chunk.overlapTokens, 35, 'sibling default preserved');
  assert.equal(config.chunk.hardTokenLimit, 254, 'sibling default preserved');
});

test('relative defaultRoots resolve against the config file directory', async () => {
  const dir = fs.realpathSync(tmpdir());
  const cfgFile = path.join(dir, 'c.json');
  fs.writeFileSync(cfgFile, JSON.stringify({ defaultRoots: ['./docs', '../sibling'] }));

  const { config } = await loadConfig({ SS_CONFIG_PATH: cfgFile });

  assert.deepEqual(config.defaultRoots, [
    path.join(dir, 'docs'),
    path.resolve(dir, '..', 'sibling'),
  ]);
  assert.equal(config.defaultRoot, path.join(dir, 'docs'), 'defaultRoot mirrors the first root');
});

test('legacy singular defaultRoot is still accepted', async () => {
  const dir = fs.realpathSync(tmpdir());
  const cfgFile = path.join(dir, 'c.json');
  fs.writeFileSync(cfgFile, JSON.stringify({ defaultRoot: '/srv/corpus' }));

  const { config } = await loadConfig({ SS_CONFIG_PATH: cfgFile });

  assert.deepEqual(config.defaultRoots, ['/srv/corpus']);
  assert.equal(config.defaultRoot, '/srv/corpus');
});

test('a missing config file yields defaults rather than throwing', async () => {
  const dir = tmpdir();
  const { config } = await loadConfig({ SS_CONFIG_PATH: path.join(dir, 'nope.json') });

  assert.deepEqual(config.defaultRoots, []);
  assert.equal(config.defaultRoot, null);
  assert.equal(config.defaultTopK, 5);
});

test('a malformed config file fails loudly, naming the file', async () => {
  const dir = tmpdir();
  const bad = path.join(dir, 'bad.json');
  fs.writeFileSync(bad, '{ this is not json ');

  await assert.rejects(
    () => loadConfig({ SS_CONFIG_PATH: bad }),
    (err) => err.message.includes(bad) && /Failed to parse/.test(err.message),
  );
});
