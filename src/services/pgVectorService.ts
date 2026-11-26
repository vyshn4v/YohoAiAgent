import pg from 'pg';
import { config } from '../config/index.js';

const { Pool } = pg;

export interface ResumeChunk {
  id: string;
  chunkIndex: number;
  title: string;
  content: string;
  metadata: Record<string, any>;
  similarity?: number;
}

export interface ChunkInput {
  chunkIndex: number;
  title: string;
  content: string;
  embedding: number[];
  metadata?: Record<string, any>;
}

let pool: pg.Pool | null = null;

export function getPgPool(): pg.Pool {
  if (!pool) {
    pool = new Pool({
      connectionString: config.postgres.url,
      ssl: config.postgres.ssl,
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 2000,
    });

    pool.on('error', (err) => {
      console.warn('[PgVector] Unexpected idle client error:', err.message);
    });
  }
  return pool;
}

/**
 * Initializes the single table for resume chunks and ensures vector extension is created.
 */
export async function initPgVectorTable(): Promise<boolean> {
  const p = getPgPool();
  const dimension = config.postgres.dimension || 768;

  try {
    // 1. Ensure pgvector extension
    await p.query('CREATE EXTENSION IF NOT EXISTS vector;');

    // 2. Create single resume_chunks table
    await p.query(`
      CREATE TABLE IF NOT EXISTS resume_chunks (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        chunk_index INT NOT NULL,
        title VARCHAR(255) NOT NULL,
        content TEXT NOT NULL,
        metadata JSONB DEFAULT '{}'::jsonb,
        embedding vector(${dimension}),
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );
    `);

    // 3. Use HNSW index (works cleanly on empty/small tables & after DELETE+INSERT without ivfflat zero-row bugs)
    await p.query('DROP INDEX IF EXISTS resume_chunks_embedding_idx;');
    await p.query(`
      CREATE INDEX IF NOT EXISTS resume_chunks_hnsw_idx
      ON resume_chunks USING hnsw (embedding vector_cosine_ops);
    `);

    return true;
  } catch (error: any) {
    console.warn(`[PgVector] Could not initialize PostgreSQL table: ${error.message}`);
    return false;
  }
}

/**
 * Atomically deletes all old chunks and inserts new chunks extracted from the resume PDF.
 * Uses a transaction to guarantee all-or-nothing replacement.
 */
export async function replaceResumeChunks(chunks: ChunkInput[]): Promise<number> {
  if (!chunks || chunks.length === 0) {
    return 0;
  }

  const p = getPgPool();
  const client = await p.connect();

  try {
    await client.query('BEGIN');

    // Delete previous chunks
    await client.query('DELETE FROM resume_chunks;');

    // Batch insert new chunks
    let inserted = 0;
    for (const chunk of chunks) {
      const vectorStr = `[${chunk.embedding.join(',')}]`;
      await client.query(
        `INSERT INTO resume_chunks (chunk_index, title, content, metadata, embedding)
         VALUES ($1, $2, $3, $4, $5::vector);`,
        [
          chunk.chunkIndex,
          chunk.title,
          chunk.content,
          JSON.stringify(chunk.metadata || {}),
          vectorStr,
        ]
      );
      inserted++;
    }

    await client.query('COMMIT');
    return inserted;
  } catch (error: any) {
    await client.query('ROLLBACK');
    throw new Error(`Failed to replace resume chunks: ${error.message}`);
  } finally {
    client.release();
  }
}

/**
 * Searches the resume_chunks table using cosine distance (<=> operator in pgvector).
 */
export async function searchResumeChunks(
  queryEmbedding: number[],
  topK = 4
): Promise<ResumeChunk[]> {
  const p = getPgPool();
  const vectorStr = `[${queryEmbedding.join(',')}]`;

  try {
    const result = await p.query(
      `SELECT id, chunk_index AS "chunkIndex", title, content, metadata,
              1 - (embedding <=> $1::vector) AS similarity
       FROM resume_chunks
       ORDER BY embedding <=> $1::vector
       LIMIT $2;`,
      [vectorStr, topK]
    );

    return result.rows.map((r: any) => ({
      id: r.id,
      chunkIndex: r.chunkIndex,
      title: r.title,
      content: r.content,
      metadata: r.metadata || {},
      similarity: Number(r.similarity),
    }));
  } catch (error: any) {
    console.warn(`[PgVector] Vector search query failed: ${error.message}`);
    return [];
  }
}

/**
 * Close pool connection (used in test teardown or process shutdown).
 */
export async function closePgPool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
