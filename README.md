# semantic-search-mcp

[![CI](https://github.com/adborroto/semantic-search-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/adborroto/semantic-search-mcp/actions/workflows/ci.yml)
[![Security](https://github.com/adborroto/semantic-search-mcp/actions/workflows/security.yml/badge.svg)](https://github.com/adborroto/semantic-search-mcp/actions/workflows/security.yml)
[![npm](https://img.shields.io/npm/v/@adborroto/semantic-search-mcp)](https://www.npmjs.com/package/@adborroto/semantic-search-mcp)
[![node](https://img.shields.io/node/v/@adborroto/semantic-search-mcp)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

A tiny, self-contained **RAG-lite retrieval engine**: it indexes files on disk and answers
"what's semantically relevant to this query" — nothing more. It does **not** call an LLM and
does **not** generate answers. It hands back the most relevant text chunks (file, line, score)
so that whatever consumes it — a human, a script, or an LLM through MCP — can decide what to do
with them.

Everything runs locally and offline after the first run:

- **Embeddings**: [`@huggingface/transformers`](https://github.com/huggingface/transformers.js)
  running `Xenova/all-MiniLM-L6-v2` with int8-quantized weights on CPU. No GPU, no API key, no
  network calls at query time.
- **Vector store**: [`@lancedb/lancedb`](https://lancedb.github.io/lancedb/) — an embedded,
  file-backed vector database. No server process, no Docker.
- **Interfaces**: a CLI and a stdio [MCP](https://modelcontextprotocol.io/) server, so any
  MCP-aware agent (Claude Code, Cursor, Zed, …) can search your corpus directly.

## Quickstart

```bash
npm install -g @adborroto/semantic-search-mcp

semantic-search add ~/code/my-project      # add a folder to the corpus
semantic-search index                      # embed it (incremental on later runs)
semantic-search search "how does the retry logic work"
```

That's the whole setup. There is no config file to write by hand — `add` creates and manages it
for you. To try it without installing anything:

```bash
npx @adborroto/semantic-search-mcp add ~/code/my-project
```

> **Heads up on install size: ~950MB of dependencies**, plus a ~25MB embedding model
> downloaded on first use. Almost all of it is native binaries you can't avoid at this layer —
> `@lancedb/lancedb` (~430MB including its platform binary) and the ONNX runtime (~300MB, which
> ships builds for every platform in one package). Both are cached once; everything after the
> first run is offline.

## Requirements

- Node.js **>= 22** (`node:sqlite`, used by the fallback backend, is only stable from 22).
- ~950MB disk for dependencies and ~25MB for the embedding model, plus roughly 1–3 KB per
  indexed chunk.
- No GPU, no external services, no database server.

## Why "RAG-lite"

A full RAG pipeline is: retrieve chunks → feed them to an LLM → LLM writes an answer. This
project stops at step one. That keeps it simple, fast, cheap to run, and easy to reason about —
and it composes cleanly with whatever LLM or agent framework you're already using, instead of
bundling its own opinionated generation layer.

## Managing the corpus

```bash
semantic-search add ~/code/api ~/notes     # add one or more folders
semantic-search list                       # show what's configured
semantic-search remove api                 # by folder name...
semantic-search remove ~/notes             # ...or by path
semantic-search config                     # where config + index actually live
```

`add` validates that each path is a real directory, resolves it to an absolute path, and skips
duplicates (including the same directory reached through a symlink). `remove` also purges that
folder's chunks from the index, so its content stops appearing in results — pass `--keep-index`
if you want to drop it from the corpus but keep it searchable.

### Where things are stored

Config and index follow the XDG base directory spec, so they survive upgrades and are shared
by every install method:

| What | Location |
|---|---|
| Config | `~/.config/semantic-search/config.json` |
| Index + model cache | `~/.local/share/semantic-search/` |

Override any of it with `SS_CONFIG_PATH`, `SS_INDEX_DIR`, `SS_MODEL_CACHE_DIR`, or the standard
`XDG_CONFIG_HOME` / `XDG_DATA_HOME`. `SS_STORE_BACKEND=sqlite` forces the fallback backend.

> **The index contains verbatim text of everything you indexed.** If you point this at private
> code, `~/.local/share/semantic-search/` holds that content in plaintext. Never commit it, and
> don't attach it to a bug report.

Every option is documented in [`src/config.js`](./src/config.js) — chunk sizing, ignore
patterns, model name, top-k, concurrency. Editing `config.json` directly still works for those;
`add`/`remove` preserve any keys they don't own.

## Usage

### Index

```bash
semantic-search index                      # all configured folders
semantic-search index ~/code/one-project   # just this folder, ignoring config
semantic-search index --force              # reprocess everything
```

Indexing is **incremental**: unchanged files are skipped by modification time, files whose
*content* didn't actually change (just touched) skip re-embedding, and files deleted from disk
get pruned from the index. Only what actually changed gets reprocessed.

With several folders configured, `index` walks them in sequence with a per-folder header and a
combined total:

```
[1/3] my-api  /home/me/code/my-api  ─────────────────────────────
  ↺ indexed   src/auth/middleware.js  (8 chunks)
  2 indexed  1,203 skipped  16 chunks  4.1s

[2/3] my-app  /home/me/code/my-app  ─────────────────────────────
  ...

──────────────────────────────────────────────────────────────
total  5 indexed  3,891 skipped  0 deleted  41 chunks  12.3s
```

Each `index <path>` call only prunes stale entries for files *under that path*, so indexing
repo B never touches repo A's entries.

Useful flags: `--max-files <n>` stops after N new files (bounds memory on huge corpora),
`--concurrency <n>` sets parallelism, `--verbose` logs each file to stderr.

### Search

```bash
semantic-search search "how does the retry logic work" -k 5
```

Prints a table of file path, line number, score, and a text preview. Under the hood: embed the
query, pull a pool of nearest vector matches, apply a small lexical boost for chunks that also
contain the literal query terms, and return the top `k`.

### Excluding files

Indexing skips `node_modules/`, `.git/`, build output, and lockfiles by default, along with
any file over 500,000 bytes. To exclude more, drop a gitignore-style `.indexignore` in either
place:

- **inside a folder you index** — patterns are relative to that folder, so a repo can exclude
  its own generated output;
- **next to your config** (`~/.config/semantic-search/.indexignore`) — applies everywhere.

See [`.indexignore.example`](./.indexignore.example) for a starting point covering iOS, Android,
Flutter, Ruby, and JVM build artifacts.

## MCP server

```bash
semantic-search mcp
```

Starts a stdio MCP server exposing six tools.

**`search(query, k?)`** — semantic search, returns raw JSON:
```
[{ filePath, text, score, offset, startLine }, ...]
```

**`gather(query, k?, contextLines?)`** — same search, returned as a single formatted markdown
block ready to drop into a context window:

````markdown
### [1/5]  my-api  ·  src/auth/session.js  ·  line 42  ·  score 0.923
```
...chunk text...
```
````

`contextLines` (default 0) reads N extra lines around each chunk from the source file — useful
when a chunk boundary cuts off context you need.

**`list_repos()`** — every configured folder with its name and absolute path. A good first call
so the agent knows what corpus exists.

**`cat_file(filePath, startLine?, endLine?)`** — read a file by absolute path, as returned by
`search`/`gather`. Confined to the configured folders (see [Security](#security)).

**`grep(pattern, repo?, fileGlob?, caseSensitive?, maxResults?)`** — literal or regex search
across the corpus, for when you need exact matches rather than similarity. Honors the same
`.indexignore` rules as indexing.

```
my-api  ·  src/auth/session.js:42  export function createSession(user) {
```

**`index(root?, force?, maxFiles?, concurrency?)`** — trigger an incremental reindex, so an
agent can refresh the corpus without shelling out.

All search tools share the same ranking and file-resolution code as the CLI; neither
reimplements it.

### Registering with an MCP client

Claude Code:

```bash
claude mcp add --scope user semantic-search -- semantic-search mcp
claude mcp list   # should show "✔ Connected"
```

Any client that takes a JSON server definition:

```json
{
  "mcpServers": {
    "semantic-search": {
      "command": "semantic-search",
      "args": ["mcp"]
    }
  }
}
```

Prefer a global install over `npx` here: a bare `npx` re-resolves the package every time the
server launches, adding startup latency and picking up upgrades unannounced. If you do use
`npx`, pin the version — `npx -y @adborroto/semantic-search-mcp@0.1.0 mcp`.

New MCP servers are usually only picked up when a session starts, so start a fresh session
after registering.

## Security

This is a **local, single-user tool** with a simple trust model: anything inside a configured
folder is readable by any MCP client that can reach the server.

- `cat_file` refuses paths outside the configured folders, resolving symlinks first so a link
  planted inside a folder can't be used to escape it.
- `grep` applies your `.indexignore` rules, so files deliberately excluded from indexing don't
  leak through exact-match search instead.
- Subprocesses are spawned with argv arrays (never a shell), so patterns can't inject commands.

Given that, **don't point it at a corpus you wouldn't hand to your LLM provider** — chunks are
returned to whatever client asked for them. See [SECURITY.md](./SECURITY.md).

## How it works

### Chunking

Text is split into paragraphs, then packed greedily into chunks of about **200 tokens** with
**~35 tokens of overlap**, counted with the embedding model's *real* tokenizer rather than a
character-count approximation. This isn't arbitrary: `all-MiniLM-L6-v2` has a **256 token**
window and silently truncates anything longer, so chunks are sized to fit inside it with margin
for the `[CLS]`/`[SEP]` tokens. Overlap is additionally capped so that overlap plus the next
paragraph can never breach that limit — otherwise a chunk's tail would be dropped at embed time
while still being returned by `search`.

A single paragraph larger than the hard limit (a minified bundle, one giant log line) falls back
to word-level packing with the same overlap logic, and any single "word" over 500 chars is
sliced first, so nothing huge is ever handed to the tokenizer in one piece.

Token counts are computed **once per paragraph/word and cached** for reuse during overlap
calculation. An earlier version re-tokenized on every overlap lookup, which was fine on small
inputs but caused runaway CPU and multi-GB memory growth on large repositories. If you extend
the chunker, preserve that property.

### Incremental reindexing

There's no separate manifest — the vector store *is* the manifest. Every stored chunk carries
its source file's `mtimeMs` and a `sha256` content hash. On each run:

1. If a file's on-disk `mtime` matches what's stored, skip it without reading the file.
2. If `mtime` changed but the content hash is identical (a `touch`), skip re-embedding.
3. Otherwise, delete that file's old chunks and insert freshly embedded ones.
4. After the walk, any indexed path no longer on disk (and under the root being indexed) is
   pruned.

### Storage backends

The default is LanceDB: embedded, file-backed, real vector search. A `node:sqlite` +
brute-force cosine fallback ([`src/store/sqliteFallbackStore.js`](./src/store/sqliteFallbackStore.js))
implements the same interface ([`src/store/vectorStore.js`](./src/store/vectorStore.js)) for
environments where LanceDB's native binding doesn't load — sandboxed containers, unusual
architectures. Switch with `SS_STORE_BACKEND=sqlite`.

The fallback does a full table scan per search: fine for tens of thousands of chunks, not
beyond. LanceDB's default metric is L2, not cosine, so this project explicitly sets
`.distanceType('cosine')` on every query, since embeddings are compared as normalized vectors.

## Project structure

```
src/
  config.js            Defaults + config file resolution (XDG) — the only source of tunables
  configFile.js        Read/modify/write the config file (backs add/remove/list)
  embeddings.js        transformers.js pipeline + tokenizer (lazy singletons)
  chunker.js           Token-aware paragraph packing with overlap
  ignoreRules.js       .indexignore layering, shared by the indexer and grep
  safePath.js          Path confinement for the MCP file-reading tools
  version.js           Version read from package.json
  extractors/          text (.txt .md .js .ts .py .rb .json), pdf (pdf-parse), docx (mammoth)
  store/
    vectorStore.js        Storage interface + backend selector
    lancedbStore.js       LanceDB implementation (default)
    sqliteFallbackStore.js node:sqlite + manual cosine fallback
  indexer.js           Walk + extract + chunk + embed + incremental upsert/prune
  search.js            Embed query + vector search + lexical boost — shared by CLI and MCP
  mcp-server.js        MCP stdio server: the six tools above
  index.js             CLI entrypoint (commander)
scripts/index-all.sh   Batched indexing for very large corpora on constrained hosts (Linux)
```

## Development

```bash
git clone https://github.com/adborroto/semantic-search-mcp.git
cd semantic-search-mcp
npm install
npm test              # unit + end-to-end (node:test, no framework)
npm run test:unit     # skip the slow end-to-end test
npm run lint
```

A `config.json` in the checkout root takes precedence over the XDG location, so you can develop
against a scratch corpus without touching your real setup. Tests always write to temp
directories. See [CONTRIBUTING.md](./CONTRIBUTING.md).

## Out of scope (by design)

- **Answer generation.** This returns chunks, not answers. Feed them to an LLM yourself.
- **Reranking with a second model.** The lexical boost is a cheap, dependency-free
  approximation — not a substitute for a real cross-encoder reranker.
- **A web UI.** CLI and MCP only.
- **Massive-scale corpora.** Built for a personal or team-sized corpus of docs and code — tens
  of thousands of chunks, not millions. Both backends assume that scale.

## License

[MIT](./LICENSE)
