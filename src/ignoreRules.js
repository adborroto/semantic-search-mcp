import fs from 'node:fs';
import path from 'node:path';
import ignoreFactory from 'ignore';
import { config } from './config.js';

/**
 * Build the ignore matcher for one indexed root.
 *
 * Rules are layered: built-in defaults, then a user-global `.indexignore` next to
 * config.json, then one inside the root itself. The per-root file matters most —
 * patterns match against paths relative to that root, so a repo can exclude its
 * own generated output without the user editing a global file.
 *
 * Lives in its own module because both the indexer and the MCP `grep` tool must
 * apply the *same* rules: a file the indexer deliberately skipped should not be
 * reachable through grep either, or the ignore list stops being a boundary.
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

/**
 * Returns a predicate that answers "is this absolute path ignored?", given a set
 * of roots. Each root gets its own matcher, and a path is tested against the
 * matcher for the root that contains it. Paths outside every root are treated as
 * ignored — nothing outside the configured corpus should ever be surfaced.
 */
export function makeIgnoreFilter(roots) {
  const matchers = roots.map(root => ({ root, ig: loadIgnore(root) }));
  return function isIgnored(absPath) {
    const entry = matchers.find(
      m => absPath === m.root || absPath.startsWith(m.root + path.sep),
    );
    if (!entry) return true;
    const rel = path.relative(entry.root, absPath);
    if (!rel || rel.startsWith('..')) return true;
    return entry.ig.ignores(rel);
  };
}
