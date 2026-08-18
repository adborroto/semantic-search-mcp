import { config } from './config.js';

/**
 * Split text into paragraphs, keeping track of each paragraph's start offset
 * in the original text (needed for offset/startLine metadata on chunks).
 * @param {string} fullText
 * @returns {Array<{ text: string, offset: number }>}
 */
function splitParagraphs(fullText) {
  const paragraphs = [];
  const re = /[^\n]+(?:\n(?!\n)[^\n]*)*/g;
  let match;
  while ((match = re.exec(fullText)) !== null) {
    if (match[0].trim().length === 0) continue;
    paragraphs.push({ text: match[0], offset: match.index });
  }
  return paragraphs;
}

function startLineFor(fullText, offset) {
  let line = 1;
  for (let i = 0; i < offset; i++) {
    if (fullText.charCodeAt(i) === 10) line++;
  }
  return line;
}

// Hard cap on the length of any single "word" handed to the tokenizer. Content with long
// unbroken runs of non-whitespace (icon-font glyph definitions, coordinate/path data, base64
// blobs) can produce a single "word" that's tens/hundreds of KB long after a plain \s+ split —
// tokenizing that in one shot was observed to spike process memory enough to trigger the
// kernel OOM killer on a 417KB icomoon selection.json that wasn't even close to the file-size
// cap. Slicing first guarantees no single string handed to the tokenizer is ever huge,
// regardless of file size or content shape.
const MAX_WORD_CHARS = 500;

function splitLongWords(words, maxChars) {
  const out = [];
  for (const w of words) {
    if (w.length <= maxChars) {
      out.push(w);
      continue;
    }
    for (let i = 0; i < w.length; i += maxChars) {
      out.push(w.slice(i, i + maxChars));
    }
  }
  return out;
}

/**
 * Token-aware word-splitting for a single paragraph that alone exceeds the
 * hard token limit (e.g. minified code, one giant line). Packs words greedily
 * using the same target/overlap budget as the paragraph-level packer.
 * Each word's token count is computed once and cached — the overlap scan
 * reuses it instead of re-tokenizing (this was the source of a serious perf/
 * memory blowup on large files before it was fixed).
 */
async function chunkOversizedParagraph(paragraph, chunkConfig, tokenCountOf, chunkIndexStart) {
  const words = splitLongWords(
    paragraph.text.split(/(\s+)/).filter((w) => w.length > 0),
    MAX_WORD_CHARS,
  );
  const results = [];
  let buffer = []; // array of { word, tokens }
  let bufferTokens = 0;
  let chunkIndex = chunkIndexStart;

  let charCursor = 0;
  let chunkStartChar = 0;

  const flush = () => {
    if (buffer.length === 0) return;
    const text = buffer.map((w) => w.word).join('');
    results.push({
      text,
      offset: paragraph.offset + chunkStartChar,
      chunkIndex: chunkIndex++,
    });
  };

  for (const word of words) {
    const wordTokens = await tokenCountOf(word);
    if (bufferTokens + wordTokens > chunkConfig.hardTokenLimit && buffer.length > 0) {
      flush();
      // seed overlap: keep trailing words worth ~overlapTokens (reuse cached counts)
      const overlapWords = [];
      let overlapTokens = 0;
      for (let i = buffer.length - 1; i >= 0 && overlapTokens < chunkConfig.overlapTokens; i--) {
        const t = buffer[i].tokens;
        if (overlapTokens + t > chunkConfig.overlapTokens) break;
        overlapWords.unshift(buffer[i]);
        overlapTokens += t;
      }
      chunkStartChar = charCursor - overlapWords.map((w) => w.word).join('').length;
      buffer = overlapWords;
      bufferTokens = overlapTokens;
    }
    buffer.push({ word, tokens: wordTokens });
    bufferTokens += wordTokens;
    charCursor += word.length;
  }
  flush();
  return { chunks: results, nextChunkIndex: chunkIndex };
}

/**
 * @param {string} fullText
 * @param {(text:string)=>Promise<any>} tokenizerFn - a transformers.js tokenizer callable
 * @param {{targetTokens:number, overlapTokens:number, hardTokenLimit:number}} [chunkConfig]
 * @returns {Promise<Array<{text:string, offset:number, startLine:number, chunkIndex:number}>>}
 */
export async function chunkText(fullText, tokenizerFn, chunkConfig = config.chunk) {
  const tokenCountOf = async (s) => {
    const enc = await tokenizerFn(s);
    return enc.input_ids.size ?? enc.input_ids.data.length;
  };

  const paragraphs = splitParagraphs(fullText);
  const rawChunks = [];
  let chunkIndex = 0;

  let buffer = []; // array of { text, offset, tokens }
  let bufferTokens = 0;

  const closeChunk = () => {
    if (buffer.length === 0) return;
    const text = buffer.map((p) => p.text).join('\n\n');
    const offset = buffer[0].offset;
    rawChunks.push({ text, offset, chunkIndex: chunkIndex++ });
  };

  for (const paragraph of paragraphs) {
    const pTokens = await tokenCountOf(paragraph.text);

    if (pTokens > chunkConfig.hardTokenLimit) {
      // oversized single paragraph: close current buffer, handle separately by word-splitting
      closeChunk();
      buffer = [];
      bufferTokens = 0;
      const { chunks: subChunks, nextChunkIndex } = await chunkOversizedParagraph(
        paragraph,
        chunkConfig,
        tokenCountOf,
        chunkIndex,
      );
      rawChunks.push(...subChunks);
      chunkIndex = nextChunkIndex;
      continue;
    }

    if (bufferTokens + pTokens > chunkConfig.targetTokens && buffer.length > 0) {
      closeChunk();
      // Seed overlap: keep trailing paragraphs worth ~overlapTokens (reuse cached counts,
      // never re-tokenize — re-tokenizing here was the bug that blew up RAM on large repos).
      //
      // The overlap budget is also constrained by hardTokenLimit, not just overlapTokens.
      // Without that second condition, overlap + a large-but-legal paragraph could exceed
      // the model's window: e.g. paragraphs of 180/20/250 tokens yielded a 270-token chunk
      // against a 254 limit. The model silently truncates at 256, so the chunk's tail was
      // never embedded while `search` still returned the full text — a retrieval miss on
      // content the index appeared to cover.
      const overlapBuffer = [];
      let overlapTokens = 0;
      for (let i = buffer.length - 1; i >= 0; i--) {
        const t = buffer[i].tokens;
        if (overlapTokens + t > chunkConfig.overlapTokens) break;
        if (overlapTokens + t + pTokens > chunkConfig.hardTokenLimit) break;
        overlapBuffer.unshift(buffer[i]);
        overlapTokens += t;
      }
      buffer = overlapBuffer;
      bufferTokens = overlapTokens;
    }

    buffer.push({ ...paragraph, tokens: pTokens });
    bufferTokens += pTokens;
  }
  closeChunk();

  return rawChunks.map((c) => ({
    text: c.text,
    offset: c.offset,
    startLine: startLineFor(fullText, c.offset),
    chunkIndex: c.chunkIndex,
  }));
}
