import { pipeline, AutoTokenizer, env } from '@huggingface/transformers';
import { config } from './config.js';

env.cacheDir = config.modelCacheDir;

let extractorPromise = null;
let tokenizerPromise = null;

function getExtractor() {
  if (!extractorPromise) {
    extractorPromise = pipeline('feature-extraction', config.modelName, {
      dtype: config.modelDtype,
      // The CPU memory arena keeps every block it ever allocates and never returns it to
      // the OS, so the process's RSS floor ratchets up to the largest inference it has run
      // and stays there for the rest of the run — the growth that made long indexing runs
      // hit the kernel OOM killer. Disabling the arena trades a small per-call allocation
      // cost for memory that is actually released between files.
      session_options: { enableCpuMemArena: false },
    });
  }
  return extractorPromise;
}

export function getTokenizer() {
  if (!tokenizerPromise) {
    tokenizerPromise = AutoTokenizer.from_pretrained(config.modelName);
  }
  return tokenizerPromise;
}

/**
 * Inputs are embedded in fixed-size batches (`config.embedBatchSize`) rather than in one
 * forward pass, so peak memory is bounded by the batch size instead of by however many
 * chunks the caller happens to pass in. Vectors come back in input order either way.
 *
 * @param {string | string[]} texts
 * @param {{batchSize?: number}} [opts]
 * @returns {Promise<number[][]>} one embedding vector per input text, L2-normalized
 */
export async function embed(texts, { batchSize = config.embedBatchSize } = {}) {
  const isSingle = typeof texts === 'string';
  const inputs = isSingle ? [texts] : texts;
  if (inputs.length === 0) return [];

  const extractor = await getExtractor();
  const size = Math.max(1, batchSize);
  const vectors = [];

  for (let start = 0; start < inputs.length; start += size) {
    const batch = inputs.slice(start, start + size);
    const output = await extractor(batch, { pooling: 'mean', normalize: true });
    const [count, dim] = output.dims;
    for (let i = 0; i < count; i++) {
      vectors.push(Array.from(output.data.slice(i * dim, (i + 1) * dim)));
    }
  }
  return vectors;
}

/** @param {string} text @returns {Promise<number>} exact token count via the model's own tokenizer */
export async function countTokens(text) {
  const tokenizer = await getTokenizer();
  const { input_ids } = await tokenizer(text);
  return input_ids.size ?? input_ids.data.length;
}
