# Changelog

All notable changes to this project are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] — Unreleased

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

### Fixed
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
- Removed an unconditional per-file debug write to stderr that fired even in MCP mode.
- `scripts/index-all.sh` no longer defaults to a hardcoded path, validates its argument, and
  skips the memory gate on platforms without `free` instead of failing.
