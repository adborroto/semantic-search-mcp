import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { search } from './search.js';
import { config } from './config.js';
import { makeIgnoreFilter } from './ignoreRules.js';
import { resolveWithinRoots } from './safePath.js';
import { version } from './version.js';

const execFileAsync = promisify(execFile);

function folderAndRel(filePath) {
  const root = config.defaultRoots.find(r => filePath.startsWith(r + path.sep));
  return {
    folder: root ? path.basename(root) : null,
    rel:  root ? path.relative(root, filePath) : filePath,
  };
}


async function expandLines(filePath, startLine, chunkText, contextLines) {
  try {
    const raw = await fsp.readFile(filePath, 'utf-8');
    const lines = raw.split('\n');
    const chunkLineCount = chunkText.split('\n').length;
    const from = Math.max(0, startLine - 1 - contextLines);
    const to   = Math.min(lines.length, startLine - 1 + chunkLineCount + contextLines);
    return lines.slice(from, to).join('\n');
  } catch {
    return chunkText;
  }
}

export async function startMcpServer() {
  const server = new McpServer({ name: 'semantic-search', version });

  server.registerTool(
    'search',
    {
      title: 'Semantic file search',
      description:
        'Search the indexed files semantically (by meaning, not just exact text) and return the '  +
        'most relevant chunks with their path, line number, and score.',
      inputSchema: {
        query: z.string().describe('Natural-language query'),
        k: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(`Number of results to return (default ${config.defaultTopK})`),
      },
    },
    async ({ query, k }) => {
      const results = await search({ query, k });
      return {
        content: [{ type: 'text', text: JSON.stringify(results, null, 2) }],
      };
    },
  );

  server.registerTool(
    'gather',
    {
      title: 'Semantic search → formatted context block',
      description:
        'Same as search, but returns the results pre-formatted as a single text block ready to '  +
        'drop into a context window: a header with folder, relative path, line, and score, followed '  +
        'by the chunk text. Optionally expands N lines of context around each chunk.',
      inputSchema: {
        query: z.string().describe('Natural-language query'),
        k: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(`Number of results (default ${config.defaultTopK})`),
        contextLines: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe('Extra lines to read before and after each chunk (default 0)'),
      },
    },
    async ({ query, k, contextLines = 0 }) => {
      const results = await search({ query, k });

      const sections = await Promise.all(
        results.map(async (r, i) => {
          const { folder, rel } = folderAndRel(r.filePath);
          const text = contextLines > 0
            ? await expandLines(r.filePath, r.startLine, r.text, contextLines)
            : r.text;

          const meta = [
            `[${i + 1}/${results.length}]`,
            folder ?? r.filePath,
            `·  ${rel}`,
            `·  line ${r.startLine}`,
            `·  score ${r.score.toFixed(3)}`,
          ].join('  ');

          return `### ${meta}\n\`\`\`\n${text}\n\`\`\``;
        }),
      );

      return {
        content: [{ type: 'text', text: sections.join('\n\n') }],
      };
    },
  );

  server.registerTool(
    'list_folders',
    {
      title: 'List indexed folders',
      description:
        'List the folders configured for indexing, with their name and absolute path. '  +
        'Useful as a first call so you know what corpus is available.',
      inputSchema: {},
    },
    async () => {
      const folders = config.defaultRoots.map(r => ({ name: path.basename(r), path: r }));
      const text = folders.map(f => `${f.name}  ${f.path}`).join('\n');
      return { content: [{ type: 'text', text }] };
    },
  );

  server.registerTool(
    'cat_file',
    {
      title: 'Read file content',
      description:
        'Read a file by absolute path, as returned by search or gather. Optionally limit to a ' +
        'line range. Only files inside the configured folders can be read.',
      inputSchema: {
        filePath: z.string().describe('Absolute path to the file'),
        startLine: z.number().int().positive().optional().describe('First line to return (1-indexed, default 1)'),
        endLine: z.number().int().positive().optional().describe('Last line to return (inclusive, default EOF)'),
      },
    },
    async ({ filePath, startLine, endLine }) => {
      const safePath = await resolveWithinRoots(filePath, config.defaultRoots);
      if (!safePath) {
        return {
          content: [{
            type: 'text',
            text: `Refused: ${filePath} is not inside any configured folder. ` +
              'Use list_folders to see what is readable.',
          }],
          isError: true,
        };
      }

      let content;
      try {
        content = await fsp.readFile(safePath, 'utf-8');
      } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
      }
      if (startLine || endLine) {
        const lines = content.split('\n');
        const from = (startLine ?? 1) - 1;
        const to = endLine ?? lines.length;
        content = lines.slice(from, to).join('\n');
      }
      const { folder, rel } = folderAndRel(safePath);
      const header = folder ? `# ${folder}  ·  ${rel}\n\n` : '';
      return { content: [{ type: 'text', text: header + content }] };
    },
  );

  server.registerTool(
    'grep',
    {
      title: 'Literal text search across folders',
      description:
        'Literal (or regex) search across the indexed folders. Complements search when you need ' +
        'exact matches rather than semantic similarity. Returns folder, relative path, line ' +
        'number, and the matching line.',
      inputSchema: {
        pattern: z.string().describe('Literal text or regex to search for'),
        folder: z.string().optional().describe('Restrict to a single folder by name, e.g. "my-api"'),
        fileGlob: z.string().optional().describe('File pattern, e.g. "*.rb" or "*.ts"'),
        caseSensitive: z.boolean().optional().describe('Match case (default false)'),
        maxResults: z.number().int().positive().optional().describe('Result limit (default 50)'),
      },
    },
    async ({ pattern, folder, fileGlob, caseSensitive = false, maxResults = 50 }) => {
      const roots = folder
        ? config.defaultRoots.filter(r => path.basename(r) === folder)
        : config.defaultRoots;

      if (!roots.length) {
        return { content: [{ type: 'text', text: `No folder found: ${folder}` }], isError: true };
      }

      const args = ['-rn', '--with-filename'];
      if (!caseSensitive) args.push('-i');
      if (fileGlob) {
        args.push(`--include=${fileGlob}`);
      } else {
        for (const ext of config.extractableExtensions) args.push(`--include=*${ext}`);
      }
      args.push('--', pattern, ...roots);

      let stdout = '';
      try {
        ({ stdout } = await execFileAsync('grep', args, { maxBuffer: 5 * 1024 * 1024 }));
      } catch (err) {
        if (err.code === 1) return { content: [{ type: 'text', text: 'No matches found.' }] };
        return { content: [{ type: 'text', text: `grep error: ${err.message}` }], isError: true };
      }

      // `grep -r` walks the raw filesystem, so it happily reports hits inside
      // node_modules, build output, or a credentials.json that the indexer was told
      // to skip (.json is in extractableExtensions). Filter through the same ignore
      // rules the indexer uses, so the ignore list is a real boundary rather than an
      // indexing-only optimisation. Filtering happens *before* the maxResults slice
      // so ignored hits don't consume the result budget.
      const isIgnored = makeIgnoreFilter(roots);
      const allHits = stdout.trimEnd().split('\n').filter(line => {
        const m = line.match(/^(.+?):(\d+):(.*)$/);
        return m ? !isIgnored(m[1]) : true;
      });

      if (!allHits.length) {
        return { content: [{ type: 'text', text: 'No matches found.' }] };
      }

      const formatted = allHits.slice(0, maxResults).map(line => {
        const m = line.match(/^(.+?):(\d+):(.*)$/);
        if (!m) return line;
        const [, filePath, lineNo, text] = m;
        const { folder: f, rel } = folderAndRel(filePath);
        return `${f ?? filePath}  ·  ${rel}:${lineNo}  ${text.trim()}`;
      }).join('\n');

      const truncated = allHits.length > maxResults
        ? `\n(showing first ${maxResults} of ${allHits.length} matches)` : '';

      return { content: [{ type: 'text', text: formatted + truncated }] };
    },
  );

  server.registerTool(
    'index',
    {
      title: 'Reindex folders',
      description:
        'Run an incremental reindex of the configured folders (or one specific directory). '  +
        'Equivalent to running `semantic-search index`. Returns a summary of files processed, '  +
        'skipped, and deleted, chunks written, and whether the run was truncated.',
      inputSchema: {
        root: z
          .string()
          .optional()
          .describe('Directory to index. Defaults to defaultRoots from the config file.'),
        force: z
          .boolean()
          .optional()
          .describe('Reprocess everything, ignoring freshness checks (default false).'),
        maxFiles: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Stop after N newly processed files (bounds memory on large corpora).'),
        concurrency: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Files processed in parallel (default 4).'),
      },
    },
    async ({ root, force = false, maxFiles, concurrency }) => {
      const scriptPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'index.js');
      const args = [scriptPath, 'index'];
      if (root) args.push(root);
      if (force) args.push('--force');
      if (maxFiles != null) args.push('--max-files', String(maxFiles));
      if (concurrency != null) args.push('--concurrency', String(concurrency));

      let stdout = '';
      try {
        ({ stdout } = await execFileAsync(process.execPath, args, {
          timeout: 10 * 60 * 1000,
          maxBuffer: 10 * 1024 * 1024,
        }));
      } catch (err) {
        const detail = err.stderr || err.stdout || err.message;
        return { content: [{ type: 'text', text: `Index error: ${detail}` }], isError: true };
      }

      // Last stdout line is JSON summary (by design — see index.js)
      const lines = stdout.trimEnd().split('\n');
      const lastLine = lines[lines.length - 1];
      let summary;
      try {
        summary = JSON.parse(lastLine);
      } catch {
        summary = { raw: stdout };
      }

      return {
        content: [{ type: 'text', text: JSON.stringify(summary, null, 2) }],
      };
    },
  );

  await server.connect(new StdioServerTransport());
}
