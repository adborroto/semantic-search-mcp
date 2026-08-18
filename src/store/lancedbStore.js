import path from 'node:path';
import * as lancedb from '@lancedb/lancedb';

const TABLE_NAME = 'chunks';
const FTS_INDEX_NAME = 'text_idx';

/**
 * LanceDB parses the full-text query with a real query syntax, so raw user input
 * containing `+`, `-`, `"`, `~`, `*` or `:` can either error or silently mean
 * something other than "find these words". Reducing the query to bare terms keeps
 * the BM25 arm predictable; phrase-level precision is the vector arm's job.
 */
function ftsTerms(query) {
  return (query.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []).join(' ');
}

function escapeSqlString(value) {
  return value.replace(/'/g, "''");
}

/** @param {import('../config.js').config} cfg */
export async function createLanceDbStore(cfg) {
  const dbPath = path.join(cfg.indexDir, 'lancedb');
  const db = await lancedb.connect(dbPath);
  let table = null;

  async function getTable() {
    if (table) return table;
    const names = await db.tableNames();
    if (names.includes(TABLE_NAME)) {
      table = await db.openTable(TABLE_NAME);
    }
    return table;
  }

  return {
    async upsertChunks(chunks) {
      if (chunks.length === 0) return;
      const t = await getTable();
      if (!t) {
        table = await db.createTable(TABLE_NAME, chunks);
      } else {
        await t.add(chunks);
      }
    },

    async deleteByFilePath(filePath) {
      const t = await getTable();
      if (!t) return;
      await t.delete(`filePath = '${escapeSqlString(filePath)}'`);
    },

    async getAllFreshness() {
      const t = await getTable();
      if (!t) return new Map();
      // chunkIndex = 0 gives exactly one row per file — avoids loading all chunks
      const rows = await t
        .query()
        .where('chunkIndex = 0')
        .select(['filePath', 'mtimeMs', 'contentHash'])
        .toArray();
      const map = new Map();
      for (const row of rows) {
        map.set(row.filePath, { mtimeMs: row.mtimeMs, contentHash: row.contentHash });
      }
      return map;
    },

    async getFreshness(filePath) {
      const t = await getTable();
      if (!t) return null;
      const rows = await t
        .query()
        .where(`filePath = '${escapeSqlString(filePath)}'`)
        .select(['mtimeMs', 'contentHash'])
        .limit(1)
        .toArray();
      if (rows.length === 0) return null;
      return { mtimeMs: rows[0].mtimeMs, contentHash: rows[0].contentHash };
    },

    async listIndexedFilePaths() {
      const t = await getTable();
      if (!t) return [];
      const rows = await t.query().select(['filePath']).toArray();
      return Array.from(new Set(rows.map((r) => r.filePath)));
    },

    /**
     * Build (or rebuild) the BM25 index over `text`.
     *
     * Called at the end of an indexing run rather than per-write: an FTS index does
     * not cover rows added after it was built, so incremental `add` calls would
     * leave the newest chunks unfindable by the lexical arm — the exact chunks a
     * user just asked to be indexed. `replace: true` makes this idempotent.
     */
    async ensureFullTextIndex() {
      const t = await getTable();
      if (!t) return;
      await t.createIndex('text', {
        config: lancedb.Index.fts(),
        name: FTS_INDEX_NAME,
        replace: true,
      });
    },

    /**
     * BM25 ranking over the chunk text. Returns [] when no FTS index exists yet
     * (an index built by an older version, or a run that never completed), so
     * hybrid search degrades to vector-only instead of failing.
     */
    async queryFullText(query, k) {
      const t = await getTable();
      if (!t) return [];
      const terms = ftsTerms(query);
      if (!terms) return [];

      const indices = await t.listIndices();
      if (!indices.some((i) => i.name === FTS_INDEX_NAME)) return [];

      const rows = await t.query().fullTextSearch(terms).limit(k).toArray();
      return rows.map((r) => ({
        id: r.id,
        text: r.text,
        filePath: r.filePath,
        offset: r.offset,
        startLine: r.startLine,
        mtimeMs: r.mtimeMs,
        contentHash: r.contentHash,
        chunkIndex: r.chunkIndex,
        score: r._score ?? 0,
      }));
    },

    async querySimilar(vector, k) {
      const t = await getTable();
      if (!t) return [];
      const rows = await t.search(vector).distanceType('cosine').limit(k).toArray();
      return rows.map((r) => ({
        id: r.id,
        text: r.text,
        filePath: r.filePath,
        offset: r.offset,
        startLine: r.startLine,
        mtimeMs: r.mtimeMs,
        contentHash: r.contentHash,
        chunkIndex: r.chunkIndex,
        score: 1 - r._distance,
      }));
    },

    async close() {
      // lancedb JS connections have no explicit close in the current API; no-op.
    },
  };
}
