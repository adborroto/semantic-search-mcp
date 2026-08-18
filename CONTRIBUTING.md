# Contributing

Thanks for taking a look. This is a small, deliberately narrow project — see
[Out of scope](./README.md#out-of-scope-by-design) before proposing a feature, since some
things are excluded on purpose rather than by omission.

## Setup

```bash
git clone https://github.com/adborroto/semantic-search-mcp.git
cd semantic-search-mcp
npm install
npm test
```

Node **>= 22** is required (`node:sqlite` is only stable from 22).

## Developing against a scratch corpus

A `config.json` in the checkout root takes precedence over `~/.config/semantic-search/`, so you
can work against test data without disturbing your real setup:

```bash
cp config.example.json config.json     # gitignored
./src/index.js add /tmp/some-scratch-corpus
./src/index.js index
```

To be extra safe, point state somewhere disposable:

```bash
export SS_CONFIG_PATH=/tmp/ss-dev/config.json
export SS_INDEX_DIR=/tmp/ss-dev/index
```

## Tests

```bash
npm test           # everything, including the end-to-end test
npm run test:unit  # skips the slow end-to-end test (SS_SKIP_INTEGRATION=1)
npm run lint
```

Tests use `node:test` — no framework dependency. Conventions:

- **Unit tests use a fake tokenizer.** Only `test/integration.test.js` loads the real embedding
  model. Keep it that way; a suite that downloads a model is a suite people stop running.
- **Never touch real state.** Always pass an explicit config path or set `SS_CONFIG_PATH` /
  `SS_INDEX_DIR` to a temp directory. Functions in `src/configFile.js` take the target file as a
  trailing argument specifically so tests don't have to mutate the environment.
- **Prefer pure functions.** `rankCandidates`, `chunkText`, `resolveWithinRoots`, and the ignore
  helpers are all exported and directly testable without a store or a model. If new logic is
  hard to test, that's usually a signal it should be extracted.

## Things worth knowing before you change them

A few behaviours look like they could be simplified but exist for a concrete reason. Each is
commented in place; the short version:

- **Token counts are cached per paragraph/word.** Re-tokenizing during overlap calculation
  caused multi-GB memory growth on large repos. Don't reintroduce it.
- **Overlap is capped by `hardTokenLimit`, not just `overlapTokens`.** Without that, a chunk can
  exceed the model's 256-token window, which silently truncates at embed time while `search`
  still returns the full text — a retrieval miss on content the index appears to cover. There's
  a regression test for this.
- **Words over 500 chars are sliced before tokenizing.** Base64 blobs and icon-font path data
  produced single "words" large enough to spike memory hard.
- **`--max-files` exists to bound process memory.** Native memory held by the ONNX runtime grows
  cumulatively across files and isn't capped by `--max-old-space-size`.
- **The last line of `index` output is JSON.** `scripts/index-all.sh` parses it to decide whether
  to relaunch. Keep it last.
- **Path confinement uses `realpath` and a trailing separator.** Both matter: symlink escapes and
  `/srv/data` vs `/srv/data-private`.

## Style

- ES modules, no build step, no TypeScript.
- Lint with `npm run lint`. The config is deliberately minimal — it catches mistakes, not style.
  There's no formatter; match the surrounding code.
- Comments should explain *why*, especially where the obvious simplification is wrong. The
  existing comments are the model.

## Pull requests

- One logical change per PR.
- Add tests for behaviour changes, and a regression test for any bug fix.
- Conventional commit subjects (`fix(chunker): ...`, `feat(cli): ...`) — the history uses them.
- Make sure `npm test` and `npm run lint` pass. CI runs both on Node 22 and 24, on Linux and
  macOS, and verifies the published tarball contains no local state.

## Reporting bugs

Include your OS, Node version, and the output of `semantic-search config`.

**Don't attach your index or config file** — both can contain content and paths from private
repositories. A redacted snippet is fine. Security issues go through
[private reporting](./SECURITY.md) instead of an issue.
