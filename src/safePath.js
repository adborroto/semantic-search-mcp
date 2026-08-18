import fsp from 'node:fs/promises';
import path from 'node:path';

/**
 * Resolve `filePath` and authorize it against `roots`, returning the real path or
 * `null` if it escapes every root.
 *
 * This is an access-control check, not cosmetics. The MCP tools are callable by
 * any connected client, and are indirectly influenced by the contents of indexed
 * files, so an unconfined read is a straightforward exfiltration path for
 * `~/.ssh/id_rsa`, `~/.aws/credentials`, or any `.env` on the machine.
 *
 * Two details matter:
 *  - Both sides go through `realpath`, so a symlink planted inside a root cannot
 *    be used to read outside it.
 *  - The `+ path.sep` guard stops `/srv/data-private` from matching root `/srv/data`.
 */
export async function resolveWithinRoots(filePath, roots) {
  let resolved;
  try {
    resolved = await fsp.realpath(path.resolve(filePath));
  } catch {
    return null; // nonexistent, or a broken symlink — nothing to authorize
  }

  for (const root of roots) {
    let realRoot;
    try {
      realRoot = await fsp.realpath(root);
    } catch {
      continue; // a configured root that no longer exists grants nothing
    }
    if (resolved === realRoot || resolved.startsWith(realRoot + path.sep)) return resolved;
  }
  return null;
}
