import path from 'node:path';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

/** @param {import('../config.js').config} cfg */
export async function createSqliteFallbackStore(cfg) {
  fs.mkdirSync(cfg.indexDir, { recursive: true });
  const dbPath = path.join(cfg.indexDir, 'index.sqlite');
  const db = new DatabaseSync(dbPath);

  db.exec(`
    CREATE TABLE IF NOT EXISTS chunks (
      id TEXT PRIMARY KEY,
      filePath TEXT NOT NULL,
      offset INTEGER,
      startLine INTEGER,
      mtimeMs REAL,
      contentHash TEXT,
      chunkIndex INTEGER,
      text TEXT,
      vector BLOB
    );
    CREATE INDEX IF NOT EXISTS idx_filepath ON chunks(filePath);
  `);

  const insertStmt = db.prepare(`
    INSERT OR REPLACE INTO chunks (id, filePath, offset, startLine, mtimeMs, contentHash, chunkIndex, text, vector)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const deleteStmt = db.prepare(`DELETE FROM chunks WHERE filePath = ?`);
  const freshnessStmt = db.prepare(
    `SELECT mtimeMs, contentHash FROM chunks WHERE filePath = ? LIMIT 1`,
  );
  const allFreshnessStmt = db.prepare(`SELECT filePath, mtimeMs, contentHash FROM chunks GROUP BY filePath`);
  const listPathsStmt = db.prepare(`SELECT DISTINCT filePath FROM chunks`);
  const allStmt = db.prepare(`SELECT * FROM chunks`);

  function vectorToBlob(vector) {
    return Buffer.from(Float32Array.from(vector).buffer);
  }
  function blobToVector(blob) {
    return Array.from(new Float32Array(blob.buffer, blob.byteOffset, blob.byteLength / 4));
  }
  function cosineSim(a, b) {
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    if (normA === 0 || normB === 0) return 0;
    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
  }

  return {
    async upsertChunks(chunks) {
      for (const c of chunks) {
        insertStmt.run(
          c.id,
          c.filePath,
          c.offset,
          c.startLine,
          c.mtimeMs,
          c.contentHash,
          c.chunkIndex,
          c.text,
          vectorToBlob(c.vector),
        );
      }
    },

    async deleteByFilePath(filePath) {
      deleteStmt.run(filePath);
    },

    async getAllFreshness() {
      const rows = allFreshnessStmt.all();
      const map = new Map();
      for (const row of rows) map.set(row.filePath, { mtimeMs: row.mtimeMs, contentHash: row.contentHash });
      return map;
    },

    async getFreshness(filePath) {
      const row = freshnessStmt.get(filePath);
      if (!row) return null;
      return { mtimeMs: row.mtimeMs, contentHash: row.contentHash };
    },

    async listIndexedFilePaths() {
      return listPathsStmt.all().map((r) => r.filePath);
    },

    /**
     * No-op: the fallback store scores lexically on the fly (see queryFullText),
     * so there is no separate index to maintain. Present so callers don't have to
     * branch on which backend they got.
     */
    async ensureFullTextIndex() {},

    /**
     * BM25 over the chunk text, computed in JS.
     *
     * node:sqlite is not guaranteed to be built with FTS5, and this store is
     * already the "works everywhere, not fast" path — it full-scans for vector
     * search too — so scoring here keeps the backend dependency-free and its
     * ranking comparable to LanceDB's.
     */
    async queryFullText(query, k) {
      const terms = [...new Set(query.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [])];
      if (terms.length === 0) return [];

      const rows = allStmt.all();
      if (rows.length === 0) return [];

      // Standard BM25 constants: k1 bounds how much repeated terms help, b sets how
      // strongly long chunks are penalised.
      const K1 = 1.2;
      const B = 0.75;

      const tokenized = rows.map((r) => (r.text ?? '').toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []);
      const avgLen = tokenized.reduce((sum, t) => sum + t.length, 0) / rows.length;

      const docFreq = new Map();
      for (const tokens of tokenized) {
        const present = new Set(tokens);
        for (const term of terms) if (present.has(term)) docFreq.set(term, (docFreq.get(term) ?? 0) + 1);
      }

      const scored = [];
      for (let i = 0; i < rows.length; i++) {
        const tokens = tokenized[i];
        if (tokens.length === 0) continue;
        let score = 0;
        for (const term of terms) {
          const df = docFreq.get(term) ?? 0;
          if (df === 0) continue;
          let tf = 0;
          for (const tok of tokens) if (tok === term) tf++;
          if (tf === 0) continue;
          const idf = Math.log(1 + (rows.length - df + 0.5) / (df + 0.5));
          score += idf * ((tf * (K1 + 1)) / (tf + K1 * (1 - B + (B * tokens.length) / avgLen)));
        }
        if (score <= 0) continue;
        const r = rows[i];
        scored.push({
          id: r.id,
          text: r.text,
          filePath: r.filePath,
          offset: r.offset,
          startLine: r.startLine,
          mtimeMs: r.mtimeMs,
          contentHash: r.contentHash,
          chunkIndex: r.chunkIndex,
          score,
        });
      }

      scored.sort((a, b) => b.score - a.score);
      return scored.slice(0, k);
    },

    async querySimilar(vector, k) {
      const rows = allStmt.all();
      const scored = rows.map((r) => ({
        id: r.id,
        text: r.text,
        filePath: r.filePath,
        offset: r.offset,
        startLine: r.startLine,
        mtimeMs: r.mtimeMs,
        contentHash: r.contentHash,
        chunkIndex: r.chunkIndex,
        score: cosineSim(vector, blobToVector(r.vector)),
      }));
      scored.sort((a, b) => b.score - a.score);
      return scored.slice(0, k);
    },

    async close() {
      db.close();
    },
  };
}
