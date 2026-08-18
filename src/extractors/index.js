import path from 'node:path';
import { config } from '../config.js';
import { extractText } from './text.js';
import { extractPdf } from './pdf.js';
import { extractDocx } from './docx.js';

/**
 * Extensions needing a real parser to get text out. Everything else is read as
 * UTF-8 — there is no allow-list of "supported" source extensions, because the
 * moment there is one, some language in the corpus is silently missing from the
 * index (.dart, .kt, .java and .tsx all were).
 */
const dispatch = {
  '.pdf': extractPdf,
  '.docx': extractDocx,
};

/**
 * @param {string} filePath
 * @returns {Promise<string|null>} extracted text, or null for known-binary types
 */
export async function extractByExtension(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (config.binaryExtensions.includes(ext)) return null;
  return (dispatch[ext] ?? extractText)(filePath);
}
