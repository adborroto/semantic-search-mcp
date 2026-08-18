# Changelog

All notable changes to this project are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.1] — 2026-08-18

### Fixed
- **Indexing no longer grows the process's memory floor with every file.** Two causes, both in
  the embedding path. First, a whole file's chunks went into a single forward pass, so the peak
  allocation scaled with file size — a 500KB file yields hundreds of chunks, and with
  `concurrency: 4` four of those peaks landed at once. Embedding now runs in fixed batches
  (`embedBatchSize`, default 16), making the peak constant regardless of file or corpus size.
  Second, ONNX's CPU memory arena keeps every block it ever allocates and never returns it to
  the OS, so RSS ratcheted up to the largest inference of the run and stayed there — the growth
  that made long runs reach the kernel OOM killer. The arena is now disabled
  (`enableCpuMemArena: false`), trading a small per-call allocation cost for memory that is
  actually released between files.
  - Note: vectors now depend slightly on batch composition (padding plus int8 dynamic
    quantization). The same text embedded alone versus in a batch differs by cos ≈ 0.99, which
    does not disturb ranking but means indexes written before and after this change are not
    bit-identical. Set `embedBatchSize: 1` to recover the old numerics at the cost of speed.

## [0.2.0] — 2026-08-18

### Changed
- **BREAKING: `list_repos` is now `list_folders`, and `grep`'s `repo` parameter is now
  `folder`.** The tool indexes arbitrary directories — nothing requires a git repo — so "repos"
  misdescribed what it does and implied git awareness that does not exist. The CLI already said
  "folders" (`add`, `list`), while the MCP layer said "repos"; `list_repos`'s own description
  hedged with "repos/folders". MCP clients calling `list_repos` or passing `repo` must update.
  No alias is kept.
- Result headers and messages now say "folder" throughout. The display prefix in `gather`/`grep`
  output is unchanged (`my-api · src/auth.js:42`) — it is the directory's basename and reads
  fine unlabelled.

### Fixed
- **File-system race around the size guard** (CodeQL `js/file-system-race`, high). Size was
  checked with `fsp.stat(path)` and the file then read with `fsp.readFile(path)`, so it could
  grow in between. That guard is the OOM safety net, so bypassing it caused exactly the failure
  it was added to prevent — and needs no adversary: a live log file, or one a build is still
  writing, grows mid-run. Stat and read now share one file handle and the read is capped at
  `maxFileSizeBytes + 1`, bounding memory even if the file grows after the handle opens.

## [0.1.0] — 2026-08-18

First public release.

### Added
- `add`, `remove`, and `list` commands to manage the corpus, so no hand-editing of a config
  file is needed.
- `config` command showing the resolved config file, index directory, model cache, and roots.
- `index` MCP tool, letting an agent trigger an incremental reindex.
- `--verbose` flag on `index` for per-file logging.
- Test suite (`node:test`) and CI across Node 22/24 on Linux and macOS, including a check that
  the published tarball carries no local state.

### Changed
- **Config and index now live in XDG directories** (`~/.config/semantic-search/`,
  `~/.local/share/semantic-search/`) instead of inside the package directory. This is what makes
  global and `npx` installs viable — previously state lived in a purgeable npm cache whose path
  changes on every version bump.
- `.indexignore` is now read from each indexed folder as well as from the config directory.
  Previously only a file at the project root was honored, so a repo could not exclude its own
  generated output.
- All CLI and MCP user-facing strings are English. Spanish MCP tool descriptions degraded tool
  selection for English-language agents.
- Minimum Node version is 22, matching `node:sqlite`'s actual requirement. The previous claim of
  18 was wrong for the sqlite fallback backend.
- MCP server version is read from `package.json` rather than hardcoded, so it can't drift.

### Security
- Migrated from the unmaintained `@xenova/transformers` v2 to `@huggingface/transformers` v3,
  and pinned `sharp` forward via an override. This clears **12 advisories (1 critical, 8 high)**
  down to zero: the critical one was arbitrary code execution in `protobufjs`, reachable through
  `onnx-proto` → `onnxruntime-web`, which transformers.js v2 loaded eagerly even for pure text
  embedding. `sharp`/libvips CVEs came in the same way.
- Added a Security workflow: CodeQL (`security-extended`), `npm audit` gated at high severity for
  runtime dependencies, dependency review with a copyleft-licence deny list on PRs, gitleaks
  secret scanning over full history, and a check that the published tarball contains no local
  config, index fragments, or absolute paths containing a real username. Runs on push, PR, and
  weekly so advisories in unchanged dependencies still surface.
- Added Dependabot for npm and GitHub Actions, grouping minor/patch bumps and isolating majors.
- Workflows declare least-privilege `permissions:` and reference tokens only via `secrets.*`.

### Fixed
- **The `dtype`/`quantized` rename was silently downgrading the model.** transformers.js v3
  ignores the v2 `quantized: true` option, so the embedding model would have loaded as fp32
  (~4x larger, slower) without a corresponding config change. Now set explicitly as
  `modelDtype: 'q8'`, preserving the previous int8 weights — existing indexes stay valid.

- **Chunks could exceed the embedding model's 256-token window.** Overlap was capped only by
  `overlapTokens`, so overlap plus a large-but-legal paragraph could produce an oversized chunk
  (e.g. 180/20/250-token paragraphs yielded 270 tokens against a 254 limit). The model silently
  truncates, so the chunk's tail was never embedded while `search` still returned the full text —
  a retrieval miss on content the index appeared to cover.
- **`cat_file` read any absolute path with no confinement.** An MCP client, or text injected into
  an indexed file, could read arbitrary files such as `~/.ssh/id_rsa` or `~/.aws/credentials`.
  Paths are now authorized against the configured folders with symlinks resolved first.
- **`grep` bypassed ignore rules.** It walked the raw filesystem, so it could surface content
  from files the indexer deliberately skipped — including `.json` credentials inside an indexed
  repo. It now applies the same `.indexignore` rules as indexing.
- **Removing a folder left its content searchable forever.** `index` only prunes stale entries
  under the root it is walking, so a folder dropped from the config was never revisited and its
  chunks — verbatim file text — kept appearing in search results. `remove` now purges them by
  default; `--keep-index` opts out.
- Removed an unconditional per-file debug write to stderr that fired even in MCP mode.
- `scripts/index-all.sh` no longer defaults to a hardcoded path, validates its argument, and
  skips the memory gate on platforms without `free` instead of failing.
