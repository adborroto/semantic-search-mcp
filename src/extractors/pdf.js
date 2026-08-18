import { readFile } from 'node:fs/promises';
import { PDFParse } from 'pdf-parse';

/** @param {string} filePath @returns {Promise<string>} */
export async function extractPdf(filePath) {
  const data = await readFile(filePath);
  const parser = new PDFParse({ data });
  try {
    const result = await parser.getText();
    return result.text ?? '';
  } finally {
    await parser.destroy();
  }
}
