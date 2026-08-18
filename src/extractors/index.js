import path from 'node:path';
import { extractText } from './text.js';
import { extractPdf } from './pdf.js';
import { extractDocx } from './docx.js';

const dispatch = {
  '.txt': extractText,
  '.md': extractText,
  '.js': extractText,
  '.ts': extractText,
  '.py': extractText,
  '.rb': extractText,
  '.json': extractText,
  '.pdf': extractPdf,
  '.docx': extractDocx,
};

/**
 * @param {string} filePath
 * @returns {Promise<string|null>} extracted text, or null if the extension isn't supported
 */
export async function extractByExtension(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const extractor = dispatch[ext];
  if (!extractor) return null;
  return extractor(filePath);
}
