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
 * @param {{query: string, k?: number}} params
 * @returns {Promise<Array<{filePath:string, text:string, score:number, offset:number, startLine:number}>>}
 */
export async function search({ query, k = config.defaultTopK } = {}) {
  const store = await getStore();
  const [queryVector] = await embed([query]);

  const candidates = await store.querySimilar(queryVector, poolSizeFor(k));

  return rankCandidates(candidates, query, k);
}

/**
 * Size of the candidate pool pulled from the vector store before reranking.
 * Must exceed k, or the lexical boost could never change which chunks land in
 * the final top-k.
 */
export function poolSizeFor(k) {
  return Math.max(k * config.searchPoolMultiplier, config.searchPoolMin);
}

/**
 * Rerank vector-search candidates with a cheap lexical boost, then take the top k.
 *
 * The boost is proportional to the fraction of query terms appearing literally in
 * the chunk, scaled by `lexicalBoostWeight`. It's a dependency-free stand-in for a
 * cross-encoder reranker: enough to lift an exact-phrase match above a marginally
 * closer but purely semantic neighbour.
 *
 * Pure and exported so ranking can be tested without a vector store or a model.
 * @param {Array<{filePath:string, text:string, score:number, offset:number, startLine:number}>} candidates
 * @param {string} query
 * @param {number} k
 */
export function rankCandidates(candidates, query, k) {
  const queryTerms = (query.toLowerCase().match(/\w+/g) ?? []).filter((t) => t.length > 0);

  const scored = candidates.map((c) => {
    const lowerText = c.text.toLowerCase();
    const matched = queryTerms.filter((t) => lowerText.includes(t)).length;
    const lexicalBoost =
      queryTerms.length > 0 ? config.lexicalBoostWeight * (matched / queryTerms.length) : 0;
    return { ...c, finalScore: c.score + lexicalBoost };
  });

  scored.sort((a, b) => b.finalScore - a.finalScore);

  return scored.slice(0, k).map((c) => ({
    filePath: c.filePath,
    text: c.text,
    score: c.finalScore,
    offset: c.offset,
    startLine: c.startLine,
  }));
}
