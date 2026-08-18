import { config } from '../config.js';
import { createLanceDbStore } from './lancedbStore.js';
import { createSqliteFallbackStore } from './sqliteFallbackStore.js';

/**
 * @typedef {Object} ChunkRecord
 * @property {string} id
 * @property {number[]} vector
 * @property {string} text
 * @property {string} filePath
 * @property {number} offset
 * @property {number} startLine
 * @property {number} mtimeMs
 * @property {string} contentHash
 * @property {number} chunkIndex
 */

/**
 * Storage contract implemented identically by lancedbStore and sqliteFallbackStore.
 * @typedef {Object} VectorStore
 * @property {(chunks: ChunkRecord[]) => Promise<void>} upsertChunks
 * @property {(filePath: string) => Promise<void>} deleteByFilePath
 * @property {() => Promise<Map<string,{mtimeMs:number, contentHash:string}>>} getAllFreshness
 * @property {(filePath: string) => Promise<{mtimeMs:number, contentHash:string}|null>} getFreshness
 * @property {() => Promise<string[]>} listIndexedFilePaths
 * @property {(vector: number[], k: number) => Promise<Array<ChunkRecord & {score:number}>>} querySimilar
 * @property {() => Promise<void>} close
 */

/** @returns {Promise<VectorStore>} */
export async function createStore() {
  if (config.storeBackend === 'sqlite') return createSqliteFallbackStore(config);
  return createLanceDbStore(config);
}
