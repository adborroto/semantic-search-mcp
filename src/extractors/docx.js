import mammoth from 'mammoth';

/** @param {string} filePath @returns {Promise<string>} */
export async function extractDocx(filePath) {
  const result = await mammoth.extractRawText({ path: filePath });
  return result.value ?? '';
}
