import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ embed: vi.fn(), list: vi.fn(), remove: vi.fn(), upsert: vi.fn() }));
vi.mock('dotenv', () => ({ default: { config: vi.fn() } }));
vi.mock('../src/services/profileLoader.js', () => ({
  getProfileFilePath: () => ({ path: '/synthetic/profile.json', format: 'json' }),
  loadProfileSections: () => [{ id: 'profile-overview', text: 'Overview' }, { id: 'profile-contact', text: 'Contact' }],
}));
vi.mock('../src/services/pineconeService.js', () => ({
  generateEmbedding: mocks.embed,
  getPineconeClient: () => ({
    listIndexes: async () => ({ indexes: [{ name: 'portfolio-agent' }] }),
    index: () => ({ namespace: () => ({ listPaginated: mocks.list, deleteMany: mocks.remove, upsert: mocks.upsert }) }),
  }),
}));
beforeEach(() => { vi.resetModules(); vi.resetAllMocks(); });
afterEach(() => { vi.unstubAllEnvs(); });

describe('Existing provider resolution', () => {
  it.each([
    ['', '', '', '', 'openrouter'],
    ['', '', '', 'nv', 'nvidia'],
    ['', '', 'gq', 'nv', 'groq'],
    ['', 'gm', 'gq', 'nv', 'gemini'],
    ['nvidia', 'gm', 'gq', 'nv', 'nvidia'],
  ])('preserves precedence (%s, %s, %s, %s)', async (provider, gemini, groq, nvidia, expected) => {
    vi.stubEnv('LLM_PROVIDER', provider);
    vi.stubEnv('GEMINI_API_KEY', gemini);
    vi.stubEnv('GROQ_API_KEY', groq);
    vi.stubEnv('NVIDIA_API_KEY', nvidia);
    vi.stubEnv('OPENROUTER_API_KEY', 'or');
    vi.stubEnv('NVIDIA_MODEL', 'synthetic-model');
    vi.stubEnv('NVIDIA_BASE_URL', 'https://example.test/v1');
    const { config } = await import('../src/config/index.js');
    expect(config.llm.provider).toBe(expected);
    const { apiKey, model, baseUrl } = config[expected as 'nvidia'];
    expect(config.llm).toMatchObject({ apiKey, model, baseUrl });
    if (expected === 'nvidia') expect(config.llm).toMatchObject({ apiKey: 'nv', model: 'synthetic-model', baseUrl: 'https://example.test/v1' });
  });
});

describe('Existing profile record cleanup', () => {
  beforeEach(() => {
    vi.stubEnv('PINECONE_API_KEY', 'synthetic');
    vi.stubEnv('PINECONE_INDEX_NAME', 'portfolio-agent');
    mocks.embed.mockResolvedValue([0.1]);
    mocks.remove.mockResolvedValue(undefined);
    mocks.upsert.mockResolvedValue(undefined);
  });
  it('deletes paginated profile IDs after embeddings and before upsert', async () => {
    mocks.list.mockResolvedValueOnce({ vectors: [{ id: 'profile-old' }], pagination: { next: 'page2' } })
      .mockResolvedValueOnce({ vectors: [{ id: 'profile-removed' }] })
      .mockResolvedValueOnce({ vectors: [{ id: 'chunk-md-99' }] });
    const { ingestProfileData } = await import('../src/scripts/ingest.js');
    expect((await ingestProfileData()).success).toBe(true);
    expect(mocks.list.mock.calls.map(([arg]) => arg.prefix)).toEqual(['profile-', 'profile-', 'chunk-md-']);
    expect(mocks.list.mock.calls[1][0].paginationToken).toBe('page2');
    expect(mocks.remove).toHaveBeenCalledWith(['profile-old', 'profile-removed', 'chunk-md-99']);
    expect(mocks.embed.mock.invocationCallOrder[1]).toBeLessThan(mocks.list.mock.invocationCallOrder[0]);
    expect(mocks.remove.mock.invocationCallOrder[0]).toBeLessThan(mocks.upsert.mock.invocationCallOrder[0]);
  });
  it('leaves existing records untouched when embedding generation fails', async () => {
    mocks.embed.mockResolvedValueOnce([0.1]).mockRejectedValueOnce(new Error('Embedding failed'));
    const { ingestProfileData } = await import('../src/scripts/ingest.js');
    await expect(ingestProfileData()).rejects.toThrow('Embedding failed');
    expect(mocks.list).not.toHaveBeenCalled();
    expect(mocks.remove).not.toHaveBeenCalled();
    expect(mocks.upsert).not.toHaveBeenCalled();
  });
});
