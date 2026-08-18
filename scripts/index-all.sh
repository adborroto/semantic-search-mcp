#!/usr/bin/env bash
# Index every top-level directory under ROOT, restarting the node process every
# BATCH_SIZE newly-processed files (not just once per directory).
#
# Why the restarts: a single long-lived process indexing thousands of files was
# observed to accumulate enough RSS to trigger the kernel OOM killer, taking an
# unrelated service on the same host down with it. The growth is cumulative over
# many files in one process — native memory held by ONNX/transformers.js, which
# --max-old-space-size does not bound — rather than one pathological file.
#
# Restarting every BATCH_SIZE files bounds memory regardless of the exact cause.
# Incremental indexing (skip by mtime/hash) makes each restart cheap for files
# already committed, so this can loop per directory until a batch reports
# truncated:false, meaning the walk finished with nothing left.
#
# Most users do not need this script — `semantic-search index` handles ordinary
# corpora fine. Reach for it when indexing a very large multi-repo tree on a
# memory-constrained or shared machine.
#
# Requires Linux: the memory gate uses `free`, which macOS does not ship. On
# other platforms the gate is skipped and only the batch cap applies.
#
# Usage: scripts/index-all.sh /path/to/parent-of-repos
set -euo pipefail

if [ "$#" -lt 1 ]; then
  echo "Usage: $0 <directory containing the repos to index>" >&2
  echo "" >&2
  echo "Environment:" >&2
  echo "  SS_BATCH_SIZE             files per process before restart (default 150)" >&2
  echo "  SS_NODE_MAX_OLD_SPACE_MB  node heap cap in MB (default 1536)" >&2
  echo "  SS_MIN_AVAILABLE_MB       wait if available memory is below this (default 3000, Linux only)" >&2
  exit 1
fi

ROOT="$1"

if [ ! -d "$ROOT" ]; then
  echo "Not a directory: $ROOT" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE_MAX_OLD_SPACE_MB="${SS_NODE_MAX_OLD_SPACE_MB:-1536}"
BATCH_SIZE="${SS_BATCH_SIZE:-150}"
MIN_AVAILABLE_MB="${SS_MIN_AVAILABLE_MB:-3000}"

wait_for_memory() {
  # Only enforceable where `free` exists; elsewhere the batch cap is the sole guard.
  command -v free >/dev/null 2>&1 || return 0

  while true; do
    available_mb=$(free -m | awk '/^Mem:/{print $7}')
    if [ "$available_mb" -ge "$MIN_AVAILABLE_MB" ]; then
      return
    fi
    echo "  low memory (${available_mb}MB available < ${MIN_AVAILABLE_MB}MB) — waiting 15s so other processes aren't starved"
    sleep 15
  done
}

failed_repos=()

for dir in "$ROOT"/*/; do
  repo="${dir%/}"
  batch_num=0

  while true; do
    batch_num=$((batch_num + 1))
    wait_for_memory
    echo "=== $(date -u +%H:%M:%S) indexing: $repo (batch $batch_num, max $BATCH_SIZE files) ==="

    if output=$(node --max-old-space-size="$NODE_MAX_OLD_SPACE_MB" "$SCRIPT_DIR/src/index.js" \
        index "$repo" --max-files "$BATCH_SIZE" 2>&1); then
      echo "$output"
    else
      node_exit=$?
      echo "$output"
      echo "  !!! FAILED (exit $node_exit): $repo (batch $batch_num)"
      failed_repos+=("$repo (batch $batch_num)")
      break
    fi

    result_line=$(echo "$output" | tail -1)
    if echo "$result_line" | grep -q '"truncated":true'; then
      sleep 2
      continue # more files left in this repo — restart with a fresh process
    fi
    break # walk finished for this repo
  done
done

if [ "${#failed_repos[@]}" -gt 0 ]; then
  echo "=== done, but ${#failed_repos[@]} batch(es) failed: ${failed_repos[*]} ==="
  exit 1
fi

echo "=== all repos processed ==="
