import { readFile } from 'node:fs/promises';

/** @param {string} filePath @returns {Promise<string>} */
export async function extractText(filePath) {
  return readFile(filePath, 'utf-8');
}
