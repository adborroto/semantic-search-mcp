import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Single source of truth for the version string, read from package.json at
 * startup. Previously the MCP server hardcoded its own version, which drifted
 * from the manifest — clients then reported a version that did not exist.
 */
const pkgPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json');

export const version = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')).version;
