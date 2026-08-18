import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Directory of the installed package. Used only to locate bundled assets
 * (config.example.json) and as a dev-mode config fallback — never for storing
 * user data. Under `npx` this resolves inside npm's purgeable _npx cache, whose
 * path changes on every version bump, so anything written here would be lost.
 */
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const homeDir = os.homedir();
const xdgConfigHome = process.env.XDG_CONFIG_HOME || path.join(homeDir, '.config');
const xdgDataHome = process.env.XDG_DATA_HOME || path.join(homeDir, '.local', 'share');

/** Canonical per-user locations, stable across upgrades and independent of install method. */
export const configDir = path.join(xdgConfigHome, 'semantic-search');
export const configPath = path.join(configDir, 'config.json');
export const dataDir = process.env.SS_INDEX_DIR || path.join(xdgDataHome, 'semantic-search');

/**
 * Config file resolution, highest precedence first:
 *   1. SS_CONFIG_PATH             — explicit override
 *   2. ~/.config/semantic-search/config.json  — canonical location (`add` writes here)
 *   3. <packageRoot>/config.json  — dev fallback, only when working inside a checkout
 */
function resolveConfigPath() {
  if (process.env.SS_CONFIG_PATH) return process.env.SS_CONFIG_PATH;
  if (fs.existsSync(configPath)) return configPath;
  const devLocal = path.join(packageRoot, 'config.json');
  if (fs.existsSync(devLocal)) return devLocal;
  return configPath; // may not exist yet — `add` creates it on demand
}

const userConfigPath = resolveConfigPath();

const defaults = {
  defaultRoots: [], // set via config.json ("defaultRoots" array or "defaultRoot" string) or passed explicitly
  defaultRoot: null, // kept for backward compat — prefer defaultRoots
  indexDir: dataDir,
  modelCacheDir: path.join(dataDir, 'models'),
  storeBackend: 'lancedb', // 'lancedb' | 'sqlite'
  modelName: 'Xenova/all-MiniLM-L6-v2',
  // 'q8' is the int8-quantized ONNX weights — ~4x smaller and faster than fp32 on
  // CPU with negligible retrieval-quality loss at this model size. transformers.js
  // v3 renamed the old boolean `quantized: true` to `dtype`; passing the old key
  // is silently ignored and you get fp32, so keep this as `dtype`.
  modelDtype: 'q8',
  vectorDim: 384, // confirmed via smoke test — must match the embedding model's real output size
  chunk: {
    targetTokens: 200,
    overlapTokens: 35,
    hardTokenLimit: 254, // 256 model max minus margin for [CLS]/[SEP]
  },
  defaultTopK: 5,
  searchPoolMultiplier: 5,
  searchPoolMin: 20,
  lexicalBoostWeight: 0.12,
  extractableExtensions: ['.txt', '.md', '.pdf', '.docx', '.js', '.ts', '.py', '.rb', '.json'],
  // Files above this size are skipped outright, regardless of extension. This is the main
  // safety net against OOM: a multi-MB file with few/no blank lines (lockfiles, minified
  // bundles, generated locale dumps) gets treated as one giant "paragraph" by the chunker and
  // falls back to word-by-word packing over hundreds of thousands of tokens — observed in
  // practice to spike process memory enough to trigger the kernel OOM killer on a 2.5MB
  // package-lock.json. Real prose/code essentially never needs more than a couple hundred KB.
  maxFileSizeBytes: 500_000,
  defaultIgnorePatterns: [
    'node_modules/',
    '.git/',
    'dist/',
    'build/',
    'coverage/',
    '*.lock',
    'package-lock.json',
    'pnpm-lock.yaml',
    'yarn.lock',
    'vendor/',
    '.next/',
    '__pycache__/',
  ],
  ignoreFile: '.indexignore',
  concurrency: 4,
};

function loadUserConfig() {
  if (!fs.existsSync(userConfigPath)) return {};
  try {
    return JSON.parse(fs.readFileSync(userConfigPath, 'utf-8'));
  } catch (err) {
    throw new Error(`Failed to parse ${userConfigPath}: ${err.message}`);
  }
}

const userConfig = loadUserConfig();

/**
 * Effective config = built-in defaults, shallow-overridden by config.json (or
 * SS_CONFIG_PATH), with `chunk` merged one level deep so a partial override
 * like {"chunk": {"targetTokens": 300}} doesn't drop overlapTokens/hardTokenLimit.
 * Relative paths in config.json are resolved against the config file's own
 * directory, so a value like "../my-docs" means the same thing regardless of
 * the process working directory.
 */
export const config = {
  ...defaults,
  ...userConfig,
  chunk: { ...defaults.chunk, ...(userConfig.chunk ?? {}) },
  packageRoot,
  configDir,
  configPath: userConfigPath,
};

const configBaseDir = path.dirname(userConfigPath);

const rawRoots = userConfig.defaultRoots
  ?? (userConfig.defaultRoot ? [userConfig.defaultRoot] : []);
config.defaultRoots = rawRoots.map(r =>
  path.isAbsolute(r) ? r : path.resolve(configBaseDir, r)
);
config.defaultRoot = config.defaultRoots[0] ?? null;

// Env vars win over config.json for storage location and backend, so a one-off
// run (or a test) can redirect state without editing the user's config file.
if (process.env.SS_INDEX_DIR) {
  config.indexDir = process.env.SS_INDEX_DIR;
  config.modelCacheDir = path.join(process.env.SS_INDEX_DIR, 'models');
}
if (process.env.SS_MODEL_CACHE_DIR) {
  config.modelCacheDir = process.env.SS_MODEL_CACHE_DIR;
}
if (process.env.SS_STORE_BACKEND) {
  config.storeBackend = process.env.SS_STORE_BACKEND;
}
