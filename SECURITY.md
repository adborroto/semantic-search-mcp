# Security Policy

## Reporting a vulnerability

Please report security issues through
[GitHub private vulnerability reporting](https://github.com/adborroto/semantic-search-mcp/security/advisories/new)
rather than a public issue. Include what you did, what happened, and what you expected.

This is a personal project maintained in spare time — expect a best-effort response, not an SLA.

## Trust model

`semantic-search-mcp` is a **local, single-user tool**. It has no network listener, no
authentication, and no multi-tenancy. The security boundary is the set of folders you configure
with `semantic-search add`:

- Everything inside a configured folder is readable by any MCP client that can talk to the
  server over stdio.
- Nothing outside those folders is reachable through the tools.

The practical implication: **don't index a corpus you wouldn't hand to your LLM provider.**
Chunks are returned to whichever client asked for them, and MCP clients typically forward them
to a model.

## What is enforced

| Control | Where |
|---|---|
| `cat_file` refuses paths outside the configured folders | `src/safePath.js` |
| Symlinks resolved before authorization, so a link inside a folder can't escape it | `src/safePath.js` |
| Path prefixes compared with a separator, so `/srv/data` doesn't authorize `/srv/data-private` | `src/safePath.js` |
| `grep` applies `.indexignore`, so excluded files don't leak via exact-match search | `src/ignoreRules.js` |
| Subprocesses spawned with argv arrays and `--`, never a shell | `src/mcp-server.js` |

These are covered by tests in `test/safePath.test.js` and `test/ignoreRules.test.js`, including
symlink-escape and prefix-sibling cases.

## Known limitations

- **The index stores plaintext.** Chunk text is written verbatim to
  `~/.local/share/semantic-search/`, unencrypted. Anyone who can read that directory can read
  everything you indexed. Treat it as being as sensitive as the most sensitive folder in your
  corpus, and never commit it or attach it to a bug report.
- **Ignore rules are not a security boundary for indexing.** `.indexignore` prevents files from
  being indexed and from appearing in `grep` results, but it is a convenience filter, not a
  sandbox. Don't rely on it to protect secrets that live inside an indexed folder — keep them
  out of the folder, or don't index that folder.
- **No prompt-injection defense.** Indexed content is returned to an LLM as context. A file in
  your corpus can contain text intended to manipulate a model that reads it. That risk is
  inherent to retrieval; this tool does not attempt to sanitize content.
- **Model download on first run.** The embedding model is fetched from the Hugging Face CDN once
  and cached. That is the only outbound network request the tool makes; there is no telemetry.

## Supported versions

The latest released version receives fixes. Given the project's size, there are no long-term
support branches.
