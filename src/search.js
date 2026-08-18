import { config } from './config.js';
import { createStore } from './store/vectorStore.js';
import { embed } from './embeddings.js';

let storePromise = null;
function getStore() {
  if (!storePromise) storePromise = createStore();
  return storePromise;
}

/**
 * Shared search implementation used by both the CLI and the MCP server —
 * neither reimplements ranking logic, both call this.
 *
 * Retrieval is hybrid: a vector query and a BM25 full-text query run over the
 * same chunks, and the two rankings are fused with RRF. The two arms fail in
 * different ways — the vector arm misses exact identifiers and error strings it
 * has no semantic handle on, the lexical arm misses paraphrases — so running
 * both is a recall fix that no amount of reranking one list can substitute for.
 *
 * Set `hybridSearch: false` in config.json (or pass `hybrid: false`) to fall
 * back to vector-only.
 *
 * @param {{query: string, k?: number, hybrid?: boolean}} params
 * @returns {Promise<Array<{filePath:string, text:string, score:number, offset:number, startLine:number}>>}
 */
export async function search({ query, k = config.defaultTopK, hybrid = config.hybridSearch } = {}) {
  const store = await getStore();
  const pool = poolSizeFor(k);

  const [queryVector] = await embed([query]);
  const vectorHits = await store.querySimilar(queryVector, pool);

  if (!hybrid) return rankCandidates(vectorHits, query, k);

  const lexicalHits = await store.queryFullText(query, pool);
  // No FTS index yet (index built by an older version) or no term matched at
  // all: fusing a single list would just reorder it by rank, so keep the
  // score-based path, which at least still applies the lexical boost.
  if (lexicalHits.length === 0) return rankCandidates(vectorHits, query, k);

  return fuseRankings([boostedOrder(vectorHits, query), lexicalHits], k);
}

/**
 * Size of the candidate pool pulled from each retrieval arm before fusion.
 * Must exceed k, or reranking could never change which chunks land in the
 * final top-k.
 */
export function poolSizeFor(k) {
  return Math.max(k * config.searchPoolMultiplier, config.searchPoolMin);
}

function chunkKey(candidate) {
  return candidate.id ?? `${candidate.filePath}::${candidate.chunkIndex}`;
}

function project(candidate) {
  return {
    filePath: candidate.filePath,
    text: candidate.text,
    score: candidate.score,
    offset: candidate.offset,
    startLine: candidate.startLine,
  };
}

/**
 * Order vector candidates by similarity plus a cheap lexical boost, proportional
 * to the fraction of query terms appearing literally in the chunk. Enough to lift
 * an exact-phrase match above a marginally closer but purely semantic neighbour.
 *
 * Kept even in hybrid mode, but applied *before* fusion rather than after: RRF
 * consumes ranks, so the boost has to change this arm's ordering to have any
 * effect. Adding it to a fused score instead would dominate it outright — RRF
 * scores sit around 1/rrfK, an order of magnitude below `lexicalBoostWeight`.
 *
 * @param {Array<{text:string, score:number}>} candidates
 * @param {string} query
 */
export function boostedOrder(candidates, query) {
  const queryTerms = (query.toLowerCase().match(/\w+/g) ?? []).filter((t) => t.length > 0);

  const scored = candidates.map((c) => {
    const lowerText = c.text.toLowerCase();
    const matched = queryTerms.filter((t) => lowerText.includes(t)).length;
    const lexicalBoost =
      queryTerms.length > 0 ? config.lexicalBoostWeight * (matched / queryTerms.length) : 0;
    return { ...c, score: c.score + lexicalBoost };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored;
}

/**
 * Rerank vector-search candidates with the lexical boost, then take the top k.
 *
 * Pure and exported so ranking can be tested without a vector store or a model.
 * @param {Array<{filePath:string, text:string, score:number, offset:number, startLine:number}>} candidates
 * @param {string} query
 * @param {number} k
 */
export function rankCandidates(candidates, query, k) {
  return boostedOrder(candidates, query).slice(0, k).map(project);
}

/**
 * Reciprocal Rank Fusion: each list contributes `1 / (rrfK + rank)` to every
 * chunk it returns, and the contributions are summed.
 *
 * Fusing on rank rather than score is the whole point — cosine similarity and
 * BM25 live on incomparable scales, with BM25 unbounded above, so any attempt to
 * add or average the raw scores lets one arm silently overwhelm the other
 * depending on corpus size. A chunk both arms rank highly beats a chunk that only
 * one of them loves, which is the behaviour we actually want.
 *
 * Pure and exported for the same reason as rankCandidates.
 *
 * @param {Array<Array<{id?:string, filePath:string, chunkIndex?:number}>>} rankings ordered best-first
 * @param {number} k
 * @param {number} [rrfK]
 */
export function fuseRankings(rankings, k, rrfK = config.rrfK) {
  const fused = new Map();

  for (const ranking of rankings) {
    ranking.forEach((candidate, index) => {
      const key = chunkKey(candidate);
      const contribution = 1 / (rrfK + index + 1);
      const existing = fused.get(key);
      if (existing) existing.score += contribution;
      else fused.set(key, { ...candidate, score: contribution });
    });
  }

  return [...fused.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
    .map(project);
}
