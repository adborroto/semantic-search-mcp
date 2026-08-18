import { pipeline, AutoTokenizer, env } from '@huggingface/transformers';
import { config } from './config.js';

env.cacheDir = config.modelCacheDir;

let extractorPromise = null;
let tokenizerPromise = null;

function getExtractor() {
  if (!extractorPromise) {
    extractorPromise = pipeline('feature-extraction', config.modelName, {
      dtype: config.modelDtype,
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
 * @param {string | string[]} texts
 * @returns {Promise<number[][]>} one embedding vector per input text, L2-normalized
 */
export async function embed(texts) {
  const isSingle = typeof texts === 'string';
  const inputs = isSingle ? [texts] : texts;
  if (inputs.length === 0) return [];

  const extractor = await getExtractor();
  const output = await extractor(inputs, { pooling: 'mean', normalize: true });

  const [count, dim] = output.dims;
  const vectors = [];
  for (let i = 0; i < count; i++) {
    vectors.push(Array.from(output.data.slice(i * dim, (i + 1) * dim)));
  }
  return vectors;
}

/** @param {string} text @returns {Promise<number>} exact token count via the model's own tokenizer */
export async function countTokens(text) {
  const tokenizer = await getTokenizer();
  const { input_ids } = await tokenizer(text);
  return input_ids.size ?? input_ids.data.length;
}
