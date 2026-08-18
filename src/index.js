#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';
import { runIndex } from './indexer.js';
import { search } from './search.js';
import { startMcpServer } from './mcp-server.js';
import { config } from './config.js';
import { addRoots, removeRoots, activeConfigPath } from './configFile.js';
import { version } from './version.js';

const program = new Command();
program
  .name('semantic-search')
  .version(version)
  .description('RAG-lite: local semantic indexing and search over files on disk');

program
  .command('add <paths...>')
  .description('Add one or more folders to the searchable corpus')
  .action((paths) => {
    const { added, already, missing, roots } = addRoots(paths);

    for (const p of added)   console.log(`added     ${p}`);
    for (const p of already) console.log(`already   ${p}`);
    for (const p of missing) console.error(`not a directory: ${p}`);

    if (added.length) {
      console.log(`\n${roots.length} folder${roots.length === 1 ? '' : 's'} configured in ${activeConfigPath}`);
      console.log('Next: semantic-search index');
    }
    if (missing.length && !added.length) process.exit(1);
  });

program
  .command('remove <paths...>')
  .alias('rm')
  .description('Remove folders from the corpus, by path or by folder name')
  .action((paths) => {
    const { removed, notFound, roots } = removeRoots(paths);

    for (const p of removed) console.log(`removed   ${p}`);
    for (const p of notFound) console.error(`not configured: ${p}`);

    if (removed.length) {
      console.log(`\n${roots.length} folder${roots.length === 1 ? '' : 's'} remaining`);
      console.log('Note: this stops future indexing. Already-indexed chunks stay until you');
      console.log('reindex or delete the index — see `semantic-search config` for its location.');
    }
    if (notFound.length && !removed.length) process.exit(1);
  });

program
  .command('list')
  .alias('ls')
  .description('List the folders currently in the corpus')
  .action(() => {
    if (!config.defaultRoots.length) {
      console.log('No folders configured yet. Add one with:');
      console.log('  semantic-search add /path/to/your/project');
      return;
    }
    for (const r of config.defaultRoots) {
      const exists = fs.existsSync(r) ? '' : '  (missing on disk)';
      console.log(`${path.basename(r).padEnd(24)} ${r}${exists}`);
    }
  });

program
  .command('index [root]')
  .description('Index (or incrementally reindex) a directory')
  .option('--force', 'reprocess everything, ignoring freshness checks', false)
  .option(
    '--max-files <n>',
    'stop after processing N new files (leaving the rest for the next run; ' +
      'bounds process memory on large corpora)',
    (v) => parseInt(v, 10),
  )
  .option('--concurrency <n>', 'files processed in parallel (default 4)', (v) => parseInt(v, 10))
  .option('--verbose', 'log every file being processed to stderr', false)
  .action(async (root, opts) => {
    const roots = root ? [root] : config.defaultRoots;
    if (!roots.length) {
      console.error('No folders configured. Add one first:');
      console.error('  semantic-search add /path/to/your/project');
      console.error('...or index a folder directly: semantic-search index /path/to/folder');
      process.exit(1);
    }

    const TTY = process.stdout.isTTY;
    const bold  = TTY ? '\x1b[1m' : '';
    const dim   = TTY ? '\x1b[2m' : '';
    const cyan  = TTY ? '\x1b[36m' : '';
    const green = TTY ? '\x1b[32m' : '';
    const reset = TTY ? '\x1b[0m' : '';
    const line  = TTY ? '─' : '-';

    let totalProcessed = 0, totalSkipped = 0, totalDeleted = 0, totalChunks = 0;
    let truncated = false;
    const t0 = Date.now();

    for (let i = 0; i < roots.length; i++) {
      const r = roots[i];
      const name = r.split('/').pop();
      const header = `${bold}${cyan}[${i + 1}/${roots.length}]${reset} ${bold}${name}${reset}  ${dim}${r}${reset}`;
      const rule = line.repeat(Math.max(0, 60 - name.length - 10));
      console.log(`\n${header}  ${dim}${rule}${reset}`);

      const result = await runIndex({
        root: r,
        force: opts.force,
        maxFiles: opts.maxFiles ?? null,
        concurrency: opts.concurrency,
        verbose: opts.verbose,
      });
      totalProcessed += result.filesProcessed;
      totalSkipped   += result.filesSkipped;
      totalDeleted   += result.filesDeleted;
      totalChunks    += result.chunksWritten;
      if (result.truncated) truncated = true;
    }

    if (roots.length > 1) {
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
      console.log(`\n${dim}${'─'.repeat(60)}${reset}`);
      console.log(`${bold}total${reset}  ${green}${bold}${totalProcessed} indexed${reset}  ${dim}${totalSkipped} skipped  ${totalDeleted} deleted  ${totalChunks} chunks  ${elapsed}s${reset}`);
    }
    // Last line is JSON on purpose: scripts/index-all.sh reads it (tail -1) to
    // detect `truncated:true` and decide whether to relaunch this repo.
    console.log(JSON.stringify({
      filesProcessed: totalProcessed,
      filesSkipped: totalSkipped,
      filesDeleted: totalDeleted,
      chunksWritten: totalChunks,
      truncated,
    }));
  });

program
  .command('search <query>')
  .description('Semantic search over the index')
  .option('-k, --top-k <n>', 'number of results', (v) => parseInt(v, 10))
  .action(async (query, opts) => {
    const results = await search({ query, k: opts.topK });
    console.table(
      results.map((r) => ({
        filePath: r.filePath,
        line: r.startLine,
        score: r.score.toFixed(4),
        text: r.text.slice(0, 120).replace(/\n/g, ' '),
      })),
    );
  });

program
  .command('config')
  .description('Show the resolved config file and storage paths')
  .action(() => {
    const cfgNote = fs.existsSync(config.configPath) ? '' : '  (not created yet — run `add`)';
    console.log(`config file   ${config.configPath}${cfgNote}`);
    console.log(`index dir     ${config.indexDir}`);
    console.log(`model cache   ${config.modelCacheDir}`);
    console.log(`backend       ${config.storeBackend}`);
    console.log(`roots         ${config.defaultRoots.length ? config.defaultRoots.join('\n              ') : '(none configured)'}`);
  });

program
  .command('mcp')
  .description('Start the MCP server (stdio), exposing the search tools')
  .action(async () => {
    await startMcpServer();
  });

program.parse();
