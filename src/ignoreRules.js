import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import ignoreFactory from 'ignore';
import { config } from './config.js';

const execFileAsync = promisify(execFile);

/**
 * Build the pattern matcher for one indexed root.
 *
 * Rules are layered: built-in defaults, then a user-global `.indexignore` next to
 * config.json, then one inside the root itself. The per-root file matters most —
 * patterns match against paths relative to that root, so a repo can exclude its
 * own generated output without the user editing a global file.
 *
 * Note this does NOT cover `.gitignore`: git's own rules can live in a
 * `.gitignore` at any depth (plus `.git/info/exclude` and the user's global
 * excludes file), which a single relative-to-root matcher cannot express. Git
 * ignoring is handled by asking git itself — see `listIndexableFiles`.
 */
export function loadIgnore(root) {
  const ig = ignoreFactory().add(config.defaultIgnorePatterns);
  for (const dir of [config.configDir, root]) {
    if (!dir) continue;
    const ignoreFilePath = path.join(dir, config.ignoreFile);
    if (fs.existsSync(ignoreFilePath)) {
      ig.add(fs.readFileSync(ignoreFilePath, 'utf-8'));
    }
  }
  return ig;
}

function isBinaryExtension(filePath) {
  return config.binaryExtensions.includes(path.extname(filePath).toLowerCase());
}

/**
 * Ask git for every file under `root` that it does not ignore: tracked files
 * (`--cached`) plus untracked ones (`--others`) with ignore rules applied
 * (`--exclude-standard`). Delegating gets nested `.gitignore` files at any
 * depth, `.git/info/exclude`, the global excludes file and negation patterns
 * (`!keep.txt`) exactly right, none of which a flat pattern list can do.
 *
 * `git ls-files` with no pathspec is scoped to the working directory, so a root
 * that is a subdirectory of a repo yields only that subtree.
 *
 * @returns {Promise<string[]|null>} root-relative paths, or null when `root`
 *   is not inside a git work tree (or git is unavailable) — callers fall back
 *   to a plain filesystem walk.
 */
async function gitListFiles(root) {
  try {
    const { stdout } = await execFileAsync('git', ['-C', root, 'rev-parse', '--is-inside-work-tree']);
    if (stdout.trim() !== 'true') return null;
  } catch {
    return null;
  }
  const { stdout } = await execFileAsync(
    'git',
    ['-C', root, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'],
    { maxBuffer: 128 * 1024 * 1024 },
  );
  return stdout.split('\0').filter(Boolean);
}

/** Recursively walk `dir`, pruning ignored directories, yielding candidate file paths. */
async function* walk(root, dir, ig) {
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    const rel = path.relative(root, abs);
    const relForIgnore = entry.isDirectory() ? `${rel}/` : rel;
    if (ig.ignores(relForIgnore)) continue;

    if (entry.isDirectory()) {
      yield* walk(root, abs, ig);
    } else if (entry.isFile() && !isBinaryExtension(abs)) {
      yield abs;
    }
  }
}

/**
 * Every file under `root` that should be indexed.
 *
 * The rule a user can hold in their head: point at a folder and everything
 * inside it is indexed, recursively. A git repo's own `.gitignore` is honored,
 * so generated and vendored output the project already excludes stays out
 * without anyone maintaining a second list. `.indexignore` (global and
 * per-root) still applies on top, for content that is committed but shouldn't
 * be searchable.
 *
 * Extensions are not allow-listed — the only extension check is a denylist of
 * known-binary types, which exists to keep image/archive bytes out of the
 * tokenizer, not to express policy about what is worth indexing. Binary files
 * with an unremarkable extension are caught later, by the NUL-byte sniff in the
 * indexer, which needs the file contents anyway.
 *
 * Symlinks are skipped: following them can escape the root entirely, and the
 * target is usually reachable under the root by its real path regardless.
 *
 * @param {string} root absolute path
 * @returns {Promise<string[]>} absolute file paths
 */
export async function listIndexableFiles(root) {
  const ig = loadIgnore(root);
  const gitFiles = await gitListFiles(root);

  if (!gitFiles) {
    const walked = [];
    for await (const abs of walk(root, root, ig)) walked.push(abs);
    return walked;
  }

  const files = [];
  for (const rel of gitFiles) {
    if (path.isAbsolute(rel) || rel.split('/').includes('..')) continue;
    if (isBinaryExtension(rel)) continue;
    if (ig.ignores(rel)) continue;
    const abs = path.join(root, rel);
    // Submodules appear as a single gitlink entry pointing at a directory, and
    // `--cached` also lists symlinks; lstat rejects both without following.
    let stat;
    try {
      stat = await fsp.lstat(abs);
    } catch {
      continue; // listed by git but gone from disk (e.g. deleted, not yet staged)
    }
    if (!stat.isFile()) continue;
    files.push(abs);
  }
  return files;
}

/**
 * Returns a predicate that answers "would this absolute path be indexed?",
 * given a set of roots.
 *
 * Built from `listIndexableFiles` rather than from the pattern matchers, so a
 * file the indexer skips cannot be reached through the MCP `grep` tool either —
 * the ignore rules stay a real boundary instead of an indexing-only
 * optimisation. Sharing one implementation is what keeps the two in step;
 * `grep` re-deriving the rules is how they drift apart.
 *
 * Paths outside every root are treated as ignored — nothing outside the
 * configured corpus should ever be surfaced.
 *
 * @param {string[]} roots absolute paths
 * @returns {Promise<(absPath: string) => boolean>}
 */
export async function makeIgnoreFilter(roots) {
  const entries = await Promise.all(
    roots.map(async (root) => ({
      root,
      indexable: new Set(await listIndexableFiles(root)),
    })),
  );

  return function isIgnored(absPath) {
    const entry = entries.find(
      (m) => absPath === m.root || absPath.startsWith(m.root + path.sep),
    );
    if (!entry) return true;
    return !entry.indexable.has(absPath);
  };
}
