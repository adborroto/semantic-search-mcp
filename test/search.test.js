import test from 'node:test';
import assert from 'node:assert/strict';
import { rankCandidates, poolSizeFor, fuseRankings, boostedOrder } from '../src/search.js';
import { config } from '../src/config.js';

const W = config.lexicalBoostWeight;

/**
 * Candidates as the vector store would return them, with cosine scores assigned.
 * a.md is the closest on pure cosine but contains none of the query terms; b.md
 * starts 0.04 lower but matches both. The boost should flip that ordering.
 */
const CANDIDATES = [
  { filePath: '/r/a.md', text: 'nothing to do with the question here', score: 0.90, offset: 0,  startLine: 1 },
  { filePath: '/r/b.md', text: 'retry backoff is described in detail', score: 0.86, offset: 10, startLine: 5 },
  { filePath: '/r/c.md', text: 'partially mentions retry only',        score: 0.85, offset: 20, startLine: 9 },
];

const near = (a, b) => Math.abs(a - b) < 1e-9;

test('lexical boost promotes a chunk containing the literal query terms', () => {
  const results = rankCandidates(CANDIDATES, 'retry backoff', 3);
  assert.equal(results[0].filePath, '/r/b.md', 'full lexical match should rank first');
});

test('boost is proportional to the fraction of query terms matched', () => {
  const byPath = Object.fromEntries(
    rankCandidates(CANDIDATES, 'retry backoff', 3).map(r => [r.filePath, r.score]),
  );

  assert.ok(near(byPath['/r/a.md'], 0.90),           'no terms matched → no boost');
  assert.ok(near(byPath['/r/c.md'], 0.85 + W * 0.5), 'half the terms → half the boost');
  assert.ok(near(byPath['/r/b.md'], 0.86 + W),       'all terms → full boost');
});

test('results are ordered by boosted score, descending', () => {
  const scores = rankCandidates(CANDIDATES, 'retry backoff', 3).map(r => r.score);
  assert.deepEqual(scores, [...scores].sort((a, b) => b - a));
});

test('k limits how many results come back', () => {
  assert.equal(rankCandidates(CANDIDATES, 'retry backoff', 1).length, 1);
  assert.equal(rankCandidates(CANDIDATES, 'retry backoff', 2).length, 2);
  assert.equal(rankCandidates(CANDIDATES, 'retry backoff', 99).length, 3, 'k above pool size is fine');
});

test('matching is case-insensitive', () => {
  assert.equal(rankCandidates(CANDIDATES, 'RETRY BACKOFF', 3)[0].filePath, '/r/b.md');
});

test('a query with no word characters yields finite scores and raw cosine order', () => {
  const results = rankCandidates(CANDIDATES, '???', 3);

  for (const r of results) assert.ok(Number.isFinite(r.score), `score ${r.score} not finite`);
  assert.equal(results[0].filePath, '/r/a.md', 'no usable terms → fall back to cosine');
  assert.ok(near(results[0].score, 0.90), 'no boost applied');
});

test('an empty candidate list returns an empty result, not a crash', () => {
  assert.deepEqual(rankCandidates([], 'retry backoff', 5), []);
});

test('returned records expose exactly the documented shape', () => {
  const [first] = rankCandidates(CANDIDATES, 'retry backoff', 1);

  assert.deepEqual(Object.keys(first).sort(), ['filePath', 'offset', 'score', 'startLine', 'text']);
  assert.equal(first.startLine, 5, 'metadata is carried through from the candidate');
  assert.equal(first.offset, 10);
});

test('term matching is plain substring containment, not whole-word', () => {
  // Documents the actual behaviour: "retry" boosts a chunk saying "retrying",
  // because the term is tested with includes() rather than a word-boundary match.
  // It also means "ret" would match — cheap and slightly loose, by design.
  const candidates = [
    { filePath: '/r/x.md', text: 'the worker is retrying the call', score: 0.5, offset: 0, startLine: 1 },
    { filePath: '/r/y.md', text: 'unrelated content entirely',      score: 0.5, offset: 0, startLine: 1 },
  ];
  const results = rankCandidates(candidates, 'retry', 2);

  assert.equal(results[0].filePath, '/r/x.md');
  assert.ok(near(results[0].score, 0.5 + W));
});

test('poolSizeFor always exceeds k and respects the configured minimum', () => {
  assert.ok(poolSizeFor(1) >= config.searchPoolMin);
  assert.ok(poolSizeFor(1) > 1, 'pool must exceed k or reranking cannot reorder the top-k');

  const bigK = config.searchPoolMin * 10;
  assert.equal(poolSizeFor(bigK), bigK * config.searchPoolMultiplier);
  assert.ok(poolSizeFor(bigK) > bigK);
});

/**
 * RRF fusion. Candidates carry `id` here because that's what the stores return and
 * what identifies a chunk across the two retrieval arms.
 */
const chunk = (id, score) => ({
  id,
  filePath: `/r/${id.split('::')[0]}`,
  chunkIndex: Number(id.split('::')[1] ?? 0),
  text: `text of ${id}`,
  score,
  offset: 0,
  startLine: 1,
});

const RRF_K = config.rrfK;

test('fusion surfaces a lexical-only hit that the vector arm never returned', () => {
  // The whole point of hybrid retrieval: e.g. an exact error string lives in
  // lex-only.rb, which is nowhere in the vector arm's pool. Reranking the vector
  // list — at any weight — could never surface it.
  const vector = [chunk('a.md::0', 0.9), chunk('b.md::0', 0.8)];
  const lexical = [chunk('lex-only.rb::3', 12.4)];

  const fused = fuseRankings([vector, lexical], 3);
  const paths = fused.map((r) => r.filePath);

  assert.ok(paths.includes('/r/lex-only.rb'), `lexical-only hit missing: ${paths.join(', ')}`);
});

test('a chunk both arms rank highly beats one only a single arm likes', () => {
  const vector = [chunk('solo.md::0', 0.95), chunk('both.md::0', 0.80)];
  const lexical = [chunk('both.md::0', 9.1), chunk('other.md::0', 2.0)];

  const [top] = fuseRankings([vector, lexical], 4);

  assert.equal(top.filePath, '/r/both.md', 'agreement across arms should win');
});

test('fusion scores are the sum of reciprocal ranks', () => {
  const vector = [chunk('x.md::0', 0.9)];      // rank 1 in the vector arm
  const lexical = [chunk('y.md::0', 5.0), chunk('x.md::0', 4.0)]; // x is rank 2 here

  const byPath = Object.fromEntries(fuseRankings([vector, lexical], 5).map((r) => [r.filePath, r.score]));

  assert.ok(near(byPath['/r/x.md'], 1 / (RRF_K + 1) + 1 / (RRF_K + 2)), 'x appears in both arms');
  assert.ok(near(byPath['/r/y.md'], 1 / (RRF_K + 1)), 'y appears in one arm');
});

test('fusion ignores the raw scores, so an unbounded BM25 score cannot dominate', () => {
  // BM25 is unbounded above while cosine sits in [-1, 1]. If fusion touched raw
  // scores, the lexical arm would always win outright on a large corpus.
  const vector = [chunk('vec.md::0', 0.99)];
  const huge = [chunk('lex.md::0', 9_999_999)];
  const tiny = [chunk('lex.md::0', 0.0001)];

  const withHuge = fuseRankings([vector, huge], 2).map((r) => r.score);
  const withTiny = fuseRankings([vector, tiny], 2).map((r) => r.score);

  assert.deepEqual(withHuge, withTiny, 'only ranks may affect the outcome');
});

test('fusion dedupes by chunk id, not by file path', () => {
  // Two different chunks of the same file are separate results; the same chunk
  // returned by both arms is one result with a summed score.
  const vector = [chunk('same.md::0', 0.9), chunk('same.md::7', 0.85)];
  const lexical = [chunk('same.md::0', 3.0)];

  const fused = fuseRankings([vector, lexical], 10);

  assert.equal(fused.length, 2, 'distinct chunks of one file stay distinct');
});

test('fused records expose the same shape as vector-only results', () => {
  const [first] = fuseRankings([[chunk('a.md::0', 0.9)], [chunk('a.md::0', 1.0)]], 1);
  assert.deepEqual(Object.keys(first).sort(), ['filePath', 'offset', 'score', 'startLine', 'text']);
});

test('fusion respects k and handles empty arms', () => {
  const vector = [chunk('a.md::0', 0.9), chunk('b.md::0', 0.8), chunk('c.md::0', 0.7)];

  assert.equal(fuseRankings([vector, []], 2).length, 2);
  assert.deepEqual(fuseRankings([[], []], 5), []);
});

test('boostedOrder keeps candidate ids so fusion can match chunks across arms', () => {
  // rankCandidates projects ids away; the vector arm feeding fusion must not.
  const [first] = boostedOrder([chunk('a.md::0', 0.9)], 'text');
  assert.equal(first.id, 'a.md::0');
});
