import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.js';
import { listIndexableFiles } from './ignoreRules.js';
import { createStore } from './store/vectorStore.js';
import { extractByExtension } from './extractors/index.js';
import { chunkText } from './chunker.js';
import { embed, getTokenizer } from './embeddings.js';

const TTY = process.stdout.isTTY;
const C = {
  reset:  TTY ? '\x1b[0m' : '',
  bold:   TTY ? '\x1b[1m' : '',
  dim:    TTY ? '\x1b[2m' : '',
  green:  TTY ? '\x1b[32m' : '',
  yellow: TTY ? '\x1b[33m' : '',
  red:    TTY ? '\x1b[31m' : '',
  cyan:   TTY ? '\x1b[36m' : '',
  gray:   TTY ? '\x1b[90m' : '',
};

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
let _spinIdx = 0;
let _hasStatus = false;

function status(done, total, indexed, chunks, elapsed, currentFile) {
  if (!TTY) return;
  const spin = SPINNER[_spinIdx++ % SPINNER.length];
  const rate = elapsed > 0.1 ? (done / elapsed).toFixed(1) : '–';
  const progress = total > 0 ? `${done}/${total}` : String(done);
  const filePart = currentFile ? `  ${C.dim}→ ${currentFile.length > 50 ? '…' + currentFile.slice(-49) : currentFile}${C.reset}` : '';
  process.stdout.write(
    `\r\x1b[2K${C.gray}  ${spin}  ${progress} · ${indexed} indexed · ${chunks} chunks · ${rate}/s${C.reset}${filePart}`,
  );
  _hasStatus = true;
}

function clearStatus() {
  if (!TTY || !_hasStatus) return;
  process.stdout.write('\r\x1b[2K');
  _hasStatus = false;
}

function print(line) {
  clearStatus();
  console.log(line);
}

class Mutex {
  #q = Promise.resolve();
  run(fn) { return (this.#q = this.#q.then(fn, fn)); }
}

/**
 * Heuristic every text editor and `grep -I` uses: a NUL byte in the first block
 * means binary. Catches the files the extension denylist can't know about —
 * a `.dat`, a `.model`, an extensionless build artifact — before their bytes
 * reach the tokenizer.
 */
function looksBinary(buffer) {
  return buffer.subarray(0, 4096).includes(0);
}

function hashBuffer(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

/**
 * @param {{root?: string, force?: boolean, maxFiles?: number, concurrency?: number, verbose?: boolean}} [opts]
 * @returns {Promise<{filesProcessed:number, filesSkipped:number, filesDeleted:number, chunksWritten:number, truncated:boolean}>}
 */
export async function runIndex({
  root = config.defaultRoot,
  force = false,
  maxFiles = null,
  concurrency = config.concurrency ?? 4,
  verbose = false,
} = {}) {
  if (!root) {
    throw new Error(
      'No root directory to index. Pass one explicitly (`semantic-search index <path>`) ' +
        'or add a folder first with `semantic-search add <path>`.',
    );
  }
  const store = await createStore();
  // Tokenizer loaded lazily — if nothing needs indexing, model never loads
  let _tokenizerPromise = null;
  const lazyTokenizer = () => { _tokenizerPromise ??= getTokenizer(); return _tokenizerPromise; };
  const writeMutex = new Mutex();

  let filesProcessed = 0;
  let filesSkipped = 0;
  let filesDeleted = 0;
  let chunksWritten = 0;
  let filesDone = 0;
  let truncated = false;
  let currentFile = '';
  const onDisk = new Set();
  const t0 = Date.now();

  // Collect all candidate paths + load freshness in bulk (1 DB query vs N per-file lookups)
  if (TTY) process.stdout.write(`\r\x1b[2K${C.gray}  ⠋  walking…${C.reset}`);
  const allFiles = await listIndexableFiles(root);
  for (const filePath of allFiles) onDisk.add(filePath);
  if (TTY) process.stdout.write(`\r\x1b[2K${C.gray}  ⠋  loading index…${C.reset}`);
  const freshnessMap = force ? new Map() : await store.getAllFreshness();
  if (TTY) process.stdout.write('\r\x1b[2K');

  // maxFiles bounds process memory for large corpora: this process embeds a
  // long-running ONNX/transformers.js session whose native memory footprint
  // was observed to climb steadily over ~1000+ files in a single process
  // (enough, in one case, to trigger the kernel OOM killer). Stopping after a
  // fixed number of *newly processed* files and letting the caller relaunch a
  // fresh process is a robust cap regardless of the exact source of growth —
  // incremental skip-by-mtime/hash makes each relaunch cheap for prior work.
  // NOTE: when truncated, the stale-entry cleanup below is skipped, because
  // `onDisk` only reflects the portion of the tree actually walked so far —
  // treating it as complete would wrongly delete not-yet-visited files.
  async function processFile(filePath) {
    if (truncated) return;
    if (maxFiles !== null && filesProcessed >= maxFiles) {
      truncated = true;
      return;
    }

    const rel = path.relative(root, filePath);
    const elapsed = () => (Date.now() - t0) / 1000;
    currentFile = rel;
    if (verbose) process.stderr.write(`processing: ${rel}\n`);

    // Size check and read go through a single file handle, and the read itself is
    // capped. Checking size with fsp.stat(path) and then reading with
    // fsp.readFile(path) is a time-of-check/time-of-use race: the file can grow in
    // between, and the size guard is the OOM safety net (see maxFileSizeBytes in
    // config.js), so bypassing it is exactly the failure it was added to prevent.
    // A live log file or one a build is still writing is enough to trigger this by
    // accident. Reading at most maxFileSizeBytes + 1 bytes bounds memory even if
    // the file grows after the handle is opened.
    const limit = config.maxFileSizeBytes;
    let stat;
    let buffer;
    let handle;
    try {
      handle = await fsp.open(filePath, 'r');
      stat = await handle.stat();

      if (stat.size > limit) {
        filesSkipped++;
        filesDone++;
        print(`  ${C.yellow}⊘${C.reset} ${C.dim}too large${C.reset}  ${C.gray}${rel}${C.reset}`);
        status(filesDone, allFiles.length, filesProcessed, chunksWritten, elapsed(), currentFile);
        return;
      }

      const existing = freshnessMap.get(filePath);
      if (existing && existing.mtimeMs === stat.mtimeMs) {
        filesSkipped++;
        filesDone++;
        status(filesDone, allFiles.length, filesProcessed, chunksWritten, elapsed(), currentFile);
        return;
      }

      const bounded = Buffer.allocUnsafe(limit + 1);
      const { bytesRead } = await handle.read(bounded, 0, limit + 1, 0);

      if (bytesRead > limit) {
        filesSkipped++;
        filesDone++;
        print(`  ${C.yellow}⊘${C.reset} ${C.dim}too large${C.reset}  ${C.gray}${rel}${C.reset}`);
        status(filesDone, allFiles.length, filesProcessed, chunksWritten, elapsed(), currentFile);
        return;
      }
      buffer = bounded.subarray(0, bytesRead);

      if (looksBinary(buffer)) {
        filesSkipped++;
        filesDone++;
        status(filesDone, allFiles.length, filesProcessed, chunksWritten, elapsed(), currentFile);
        return;
      }
    } catch (err) {
      filesDone++;
      print(`  ${C.red}✗${C.reset} ${C.dim}read error${C.reset}  ${C.gray}${rel}${C.reset}  ${C.dim}${err.message}${C.reset}`);
      status(filesDone, allFiles.length, filesProcessed, chunksWritten, elapsed(), currentFile);
      return;
    } finally {
      await handle?.close();
    }

    const existing = freshnessMap.get(filePath);
    const contentHash = hashBuffer(buffer);

    if (existing && existing.contentHash === contentHash) {
      filesSkipped++;
      filesDone++;
      status(filesDone, allFiles.length, filesProcessed, chunksWritten, elapsed(), currentFile);
      return;
    }

    let text;
    try {
      text = await extractByExtension(filePath);
    } catch (err) {
      filesDone++;
      print(`  ${C.red}✗${C.reset} ${C.dim}extract error${C.reset}  ${C.gray}${rel}${C.reset}  ${C.dim}${err.message}${C.reset}`);
      status(filesDone, allFiles.length, filesProcessed, chunksWritten, elapsed(), currentFile);
      return;
    }
    if (!text || text.trim().length === 0) {
      filesSkipped++;
      filesDone++;
      status(filesDone, allFiles.length, filesProcessed, chunksWritten, elapsed(), currentFile);
      return;
    }

    const chunks = await chunkText(text, await lazyTokenizer(), config.chunk);
    if (chunks.length === 0) {
      filesSkipped++;
      filesDone++;
      status(filesDone, allFiles.length, filesProcessed, chunksWritten, elapsed(), currentFile);
      return;
    }

    const vectors = await embed(chunks.map((c) => c.text));
    const records = chunks.map((c, i) => ({
      id: `${filePath}::${c.chunkIndex}`,
      vector: vectors[i],
      text: c.text,
      filePath,
      offset: c.offset,
      startLine: c.startLine,
      mtimeMs: stat.mtimeMs,
      contentHash,
      chunkIndex: c.chunkIndex,
    }));

    await writeMutex.run(async () => {
      await store.deleteByFilePath(filePath);
      await store.upsertChunks(records);
    });
    chunksWritten += records.length;
    filesProcessed++;
    filesDone++;
    print(`  ${C.green}↺${C.reset} ${C.bold}indexed${C.reset}   ${rel}  ${C.dim}(${records.length} chunks)${C.reset}`);
    status(filesDone, allFiles.length, filesProcessed, chunksWritten, elapsed(), currentFile);
  }

  // Bounded concurrency pool: N workers share the file list via atomic index
  let idx = 0;
  const workers = Array.from({ length: Math.min(concurrency, allFiles.length || 1) }, async () => {
    while (true) {
      const i = idx++;
      if (i >= allFiles.length || truncated) break;
      await processFile(allFiles[i]);
    }
  });
  await Promise.all(workers);

  // Only clean up entries that fall under THIS root — entries indexed from a
  // different root (e.g. another repo indexed in a separate run) are out of
  // scope for this walk and must not be treated as "deleted". Skipped
  // entirely on a truncated (maxFiles-limited) run — see note above.
  if (!truncated) {
    const rootPrefix = path.resolve(root) + path.sep;
    const indexed = await store.listIndexedFilePaths();
    for (const indexedPath of indexed) {
      if (!indexedPath.startsWith(rootPrefix)) continue;
      if (!onDisk.has(indexedPath)) {
        await store.deleteByFilePath(indexedPath);
        filesDeleted++;
        const rel = path.relative(root, indexedPath);
        print(`  ${C.red}✂${C.reset} ${C.dim}deleted${C.reset}   ${C.gray}${rel}${C.reset}`);
      }
    }
  }

  // Built once per run, after every write: an FTS index doesn't cover rows added
  // after it was created, so refreshing it here is what makes the chunks this run
  // just wrote reachable by hybrid search's lexical arm.
  if (chunksWritten > 0 || filesDeleted > 0) {
    if (TTY) process.stdout.write(`\r\x1b[2K${C.gray}  ⠋  building text index…${C.reset}`);
    try {
      await store.ensureFullTextIndex();
    } catch (err) {
      print(`  ${C.yellow}⊘${C.reset} ${C.dim}text index skipped${C.reset}  ${C.dim}${err.message}${C.reset}`);
    }
  }

  clearStatus();
  const elapsed = (Date.now() - t0) / 1000;
  const rate = elapsed > 0.1 ? (filesDone / elapsed).toFixed(1) : '–';
  const parts = [
    filesProcessed > 0 ? `${C.green}${C.bold}${filesProcessed} indexed${C.reset}` : `${C.dim}0 indexed${C.reset}`,
    `${C.dim}${filesSkipped} skipped${C.reset}`,
    filesDeleted > 0 ? `${C.red}${filesDeleted} deleted${C.reset}` : null,
    chunksWritten > 0 ? `${C.cyan}${chunksWritten} chunks${C.reset}` : null,
    `${C.dim}${elapsed.toFixed(1)}s${C.reset}`,
    `${C.dim}(${rate}/s)${C.reset}`,
  ].filter(Boolean).join('  ');
  console.log(`  ${parts}`);

  await store.close();
  return { filesProcessed, filesSkipped, filesDeleted, chunksWritten, truncated };
}

/**
 * Delete every indexed chunk belonging to the given roots.
 *
 * `runIndex` only prunes stale entries *under the root it is currently walking*,
 * so a folder dropped from the config is never revisited and its chunks would
 * otherwise stay in the index — and keep surfacing in search results — forever.
 * That matters beyond tidiness: the index holds verbatim text, so a user who
 * removes a private folder reasonably expects its content to stop being served.
 *
 * @param {string[]} roots absolute paths whose chunks should be removed
 * @returns {Promise<{filesDeleted:number}>}
 */
export async function purgeRoots(roots) {
  if (!roots.length) return { filesDeleted: 0 };

  const store = await createStore();
  let filesDeleted = 0;
  try {
    const prefixes = roots.map(r => path.resolve(r) + path.sep);
    const indexed = await store.listIndexedFilePaths();

    for (const indexedPath of indexed) {
      if (!prefixes.some(p => indexedPath.startsWith(p))) continue;
      await store.deleteByFilePath(indexedPath);
      filesDeleted++;
    }
  } finally {
    await store.close();
  }
  return { filesDeleted };
}
