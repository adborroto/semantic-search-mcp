import test from 'node:test';
import assert from 'node:assert/strict';
import { chunkText } from '../src/chunker.js';

/**
 * Fake tokenizer: one token per whitespace-separated word, matching the shape
 * transformers.js returns. Using a fake keeps these tests hermetic and fast —
 * no 25MB model download in CI — and the packing logic is what's under test,
 * not the tokenizer itself.
 */
const tok = async (s) => ({ input_ids: { size: s.split(/\s+/).filter(Boolean).length } });
const countWords = (s) => s.split(/\s+/).filter(Boolean).length;

const CFG = { targetTokens: 200, overlapTokens: 35, hardTokenLimit: 254 };

/** n paragraphs' worth of distinct words, so overlap is detectable by content. */
const para = (n, tag) => Array.from({ length: n }, (_, i) => `${tag}${i}`).join(' ');

test('empty and whitespace-only input produce no chunks', async () => {
  assert.deepEqual(await chunkText('', tok, CFG), []);
  assert.deepEqual(await chunkText('   \n\n  \t ', tok, CFG), []);
});

test('short input stays a single chunk', async () => {
  const chunks = await chunkText('a short paragraph of text', tok, CFG);
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].chunkIndex, 0);
  assert.equal(chunks[0].startLine, 1);
  assert.equal(chunks[0].offset, 0);
});

test('long input splits into ordered chunks with sequential indices', async () => {
  const text = Array.from({ length: 10 }, (_, i) => para(60, `p${i}w`)).join('\n\n');
  const chunks = await chunkText(text, tok, CFG);

  assert.ok(chunks.length > 1, 'should produce multiple chunks');
  assert.deepEqual(
    chunks.map(c => c.chunkIndex),
    chunks.map((_, i) => i),
    'chunkIndex must be sequential from 0',
  );
  const offsets = chunks.map(c => c.offset);
  assert.deepEqual(offsets, [...offsets].sort((a, b) => a - b), 'offsets must be ascending');
});

test('consecutive chunks overlap, and the overlap respects overlapTokens', async () => {
  // Small paragraphs so several fit in the overlap budget.
  const text = Array.from({ length: 30 }, (_, i) => para(10, `s${i}w`)).join('\n\n');
  const chunks = await chunkText(text, tok, CFG);
  assert.ok(chunks.length > 1);

  const firstWords = chunks[0].text.split(/\s+/).filter(Boolean);
  const secondWords = chunks[1].text.split(/\s+/).filter(Boolean);
  const shared = secondWords.filter(w => firstWords.includes(w));

  assert.ok(shared.length > 0, 'chunk 2 should re-include the tail of chunk 1');
  assert.ok(
    shared.length <= CFG.overlapTokens,
    `overlap of ${shared.length} exceeds overlapTokens ${CFG.overlapTokens}`,
  );
});

test('no chunk ever exceeds hardTokenLimit', async () => {
  const text = Array.from({ length: 25 }, (_, i) => para(40 + (i % 7) * 30, `v${i}w`)).join('\n\n');
  const chunks = await chunkText(text, tok, CFG);

  for (const c of chunks) {
    assert.ok(
      countWords(c.text) <= CFG.hardTokenLimit,
      `chunk ${c.chunkIndex} has ${countWords(c.text)} tokens, over limit ${CFG.hardTokenLimit}`,
    );
  }
});

test('overlap yields rather than breach the model window (regression)', async () => {
  // Regression for a real defect: paragraphs of 180/20/250 tokens produced a
  // 270-token chunk against a 254 limit. all-MiniLM-L6-v2 silently truncates at
  // 256, so the chunk tail was never embedded even though `search` returned the
  // full text — a retrieval miss on content the index appeared to cover.
  const text = [para(180, 'a'), para(20, 'b'), para(250, 'c')].join('\n\n');
  const chunks = await chunkText(text, tok, CFG);

  for (const c of chunks) {
    assert.ok(
      countWords(c.text) <= CFG.hardTokenLimit,
      `chunk ${c.chunkIndex} has ${countWords(c.text)} tokens, over limit ${CFG.hardTokenLimit}`,
    );
  }
});

test('a single oversized paragraph is word-split, not truncated', async () => {
  // The minified-bundle / one-giant-log-line case: no blank lines at all.
  const oneHugeParagraph = para(1200, 'w');
  const chunks = await chunkText(oneHugeParagraph, tok, CFG);

  assert.ok(chunks.length > 1, 'oversized paragraph must be split across chunks');
  for (const c of chunks) {
    assert.ok(
      countWords(c.text) <= CFG.hardTokenLimit,
      `word-level chunk has ${countWords(c.text)} tokens, over limit ${CFG.hardTokenLimit}`,
    );
  }

  // Nothing may be dropped: every source word must appear somewhere.
  const seen = new Set(chunks.flatMap(c => c.text.split(/\s+/).filter(Boolean)));
  for (let i = 0; i < 1200; i++) {
    assert.ok(seen.has(`w${i}`), `word w${i} was dropped entirely`);
  }
});

test('extremely long single "words" are sliced before tokenizing', async () => {
  // A base64 blob or icon-font path definition: one whitespace-free run of 200k
  // chars. Handing that to the tokenizer in one piece previously spiked memory
  // hard enough to trigger the OOM killer, so the chunker slices any word past
  // MAX_WORD_CHARS (500) first.
  //
  // This needs a char-aware tokenizer: the word-counting fake used elsewhere
  // would score the whole blob as a single token, so the oversized-paragraph
  // path would never be exercised.
  const charTok = async (s) => ({ input_ids: { size: Math.ceil(s.length / 4) } });
  const blob = 'x'.repeat(200_000);

  const chunks = await chunkText(blob, charTok, CFG);

  assert.ok(chunks.length > 1, 'a 200k-char blob must be split across chunks');
  for (const c of chunks) {
    const tokens = Math.ceil(c.text.length / 4);
    assert.ok(
      tokens <= CFG.hardTokenLimit,
      `chunk of ${tokens} tokens exceeds hardTokenLimit ${CFG.hardTokenLimit}`,
    );
  }
  // No character may be lost: slicing must be lossless, ignoring overlap repeats.
  const totalChars = chunks.reduce((n, c) => n + c.text.length, 0);
  assert.ok(totalChars >= blob.length, 'slicing dropped characters');
});

test('startLine reflects the real line number in the source', async () => {
  const text = ['line one', '', 'line three', '', 'line five'].join('\n');
  const chunks = await chunkText(text, tok, CFG);
  assert.equal(chunks[0].startLine, 1);

  // Force a split so a later chunk starts further down the file.
  const big = [para(150, 'a'), para(150, 'b')].join('\n\n');
  const split = await chunkText(big, tok, CFG);
  assert.ok(split.length > 1);
  assert.ok(split[1].startLine > 1, 'second chunk should not claim line 1');
});
