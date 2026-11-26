import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  generateDeterministicEmbedding,
  generateTextEmbedding,
} from '../src/services/embeddingService.js';
import {
  initPgVectorTable,
  replaceResumeChunks,
  searchResumeChunks,
  getPgPool,
  closePgPool,
} from '../src/services/pgVectorService.js';

describe('PostgreSQL pgVector and Embedding Services', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(async () => {
    await closePgPool();
  });

  describe('Embedding Service (gemini-embedding-2)', () => {
    it('should generate deterministic fallback embeddings when offline or testing', async () => {
      const vec1 = await generateTextEmbedding('Full-stack developer with LangGraph');
      const vec2 = await generateTextEmbedding('Full-stack developer with LangGraph');
      const vecDiff = await generateTextEmbedding('Completely different query');

      expect(vec1).toBeDefined();
      expect(vec1.length).toBe(768);
      expect(vec1).toEqual(vec2);
      expect(vec1).not.toEqual(vecDiff);
    });

    it('should handle empty or whitespace text gracefully without crashing', async () => {
      const vec = await generateTextEmbedding('   ');
      expect(vec).toBeDefined();
      expect(vec.length).toBe(768);
    });

    it('should produce normalized vectors with unit length approx 1.0', () => {
      const vec = generateDeterministicEmbedding('test normalization');
      const magnitude = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0));
      expect(magnitude).toBeCloseTo(1.0, 2);
    });
  });

  describe('pgVector Service', () => {
    it('should handle database errors gracefully and return empty list on failure', async () => {
      const pool = getPgPool();
      vi.spyOn(pool, 'query').mockRejectedValue(new Error('Connection refused'));

      const results = await searchResumeChunks([0.1, 0.2, 0.3]);
      expect(results).toEqual([]);
    });

    it('should initialize table and index when database is connected', async () => {
      const pool = getPgPool();
      const querySpy = vi.spyOn(pool, 'query').mockResolvedValue({ rows: [] } as any);

      const success = await initPgVectorTable();
      expect(success).toBe(true);
      expect(querySpy).toHaveBeenCalledWith(expect.stringContaining('CREATE EXTENSION IF NOT EXISTS vector'));
      expect(querySpy).toHaveBeenCalledWith(expect.stringContaining('CREATE TABLE IF NOT EXISTS resume_chunks'));
    });

    it('should replace chunks in an atomic transaction', async () => {
      const pool = getPgPool();
      const mockClient = {
        query: vi.fn().mockResolvedValue({ rows: [] }),
        release: vi.fn(),
      };
      vi.spyOn(pool, 'connect').mockResolvedValue(mockClient as any);

      const chunks = [
        {
          chunkIndex: 0,
          title: 'Experience',
          content: 'Software Engineer at Neutrinos',
          embedding: [0.1, 0.2, 0.3],
          metadata: { page: 1 },
        },
      ];

      const count = await replaceResumeChunks(chunks);
      expect(count).toBe(1);
      expect(mockClient.query).toHaveBeenCalledWith('BEGIN');
      expect(mockClient.query).toHaveBeenCalledWith('DELETE FROM resume_chunks;');
      expect(mockClient.query).toHaveBeenCalledWith('COMMIT');
      expect(mockClient.release).toHaveBeenCalled();
    });

    it('should rollback transaction if insertion fails', async () => {
      const pool = getPgPool();
      const mockClient = {
        query: vi.fn().mockImplementation((sql: string) => {
          if (sql.startsWith('INSERT INTO')) throw new Error('Unique constraint violated');
          return { rows: [] };
        }),
        release: vi.fn(),
      };
      vi.spyOn(pool, 'connect').mockResolvedValue(mockClient as any);

      await expect(
        replaceResumeChunks([
          {
            chunkIndex: 0,
            title: 'Test',
            content: 'Failing chunk',
            embedding: [0.1],
          },
        ])
      ).rejects.toThrow('Failed to replace resume chunks');

      expect(mockClient.query).toHaveBeenCalledWith('ROLLBACK');
      expect(mockClient.release).toHaveBeenCalled();
    });
  });
});
