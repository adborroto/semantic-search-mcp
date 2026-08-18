import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

/**
 * Read/modify/write helpers for the user's config file.
 *
 * The file exists because the MCP server launches as a bare process with no
 * arguments — it has to read the corpus list from somewhere persistent. But the
 * user should never have to open it: `add`, `remove`, and `list` are the intended
 * interface, and they create the file on demand.
 *
 * Every function takes the target file as a trailing argument defaulting to the
 * *active* config path — the same file config.js resolved at startup, whether
 * that's the XDG location, an SS_CONFIG_PATH override, or a dev-mode config.json
 * in a checkout. Writing to the canonical XDG path while reads came from
 * elsewhere would make `add` look like it did nothing.
 *
 * Unknown keys are preserved on write, so hand-edits and future options survive
 * an `add`/`remove`.
 */

/** The config file `add`/`remove` modify by default. Exported for the CLI to report. */
export const activeConfigPath = config.configPath;

export function readConfigFile(file = activeConfigPath) {
  if (!fs.existsSync(file)) return {};
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch (err) {
    throw new Error(`Failed to parse ${file}: ${err.message}`);
  }
}

export function writeConfigFile(data, file = activeConfigPath) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
}

/** Roots as stored in the file, normalized to absolute paths. */
export function readRoots(file = activeConfigPath) {
  const data = readConfigFile(file);
  const raw = data.defaultRoots ?? (data.defaultRoot ? [data.defaultRoot] : []);
  return raw.map(r => (path.isAbsolute(r) ? r : path.resolve(path.dirname(file), r)));
}

/**
 * Add one or more directories to the corpus. Returns what actually changed, so the
 * CLI can report precisely instead of claiming success for a no-op.
 * @param {string[]} inputPaths
 * @param {string} [file]
 */
export function addRoots(inputPaths, file = activeConfigPath) {
  const data = readConfigFile(file);
  const roots = readRoots(file);

  const added = [];
  const already = [];
  const missing = [];

  for (const input of inputPaths) {
    const abs = path.resolve(input);

    if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
      missing.push(abs);
      continue;
    }
    // realpath so the same directory reached via a symlink isn't stored twice
    const real = fs.realpathSync(abs);
    if (roots.some(r => safeReal(r) === real)) {
      already.push(real);
      continue;
    }
    roots.push(real);
    added.push(real);
  }

  if (added.length) {
    delete data.defaultRoot; // collapse the legacy singular key into the array
    data.defaultRoots = roots;
    writeConfigFile(data, file);
  }

  return { added, already, missing, roots };
}

/**
 * Remove roots by absolute path or by folder name, so `remove my-api` works
 * without the user retyping a long path.
 * @param {string[]} targets
 * @param {string} [file]
 */
export function removeRoots(targets, file = activeConfigPath) {
  const data = readConfigFile(file);
  let roots = readRoots(file);

  const removed = [];
  const notFound = [];

  for (const target of targets) {
    const abs = path.resolve(target);
    const match = roots.find(
      r => r === abs || safeReal(r) === safeReal(abs) || path.basename(r) === target,
    );
    if (!match) {
      notFound.push(target);
      continue;
    }
    roots = roots.filter(r => r !== match);
    removed.push(match);
  }

  if (removed.length) {
    delete data.defaultRoot;
    data.defaultRoots = roots;
    writeConfigFile(data, file);
  }

  return { removed, notFound, roots };
}

/** realpath that degrades to its input rather than throwing on a stale path. */
function safeReal(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}
