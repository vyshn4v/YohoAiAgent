import path from 'path';
import { config } from '../config/index.js';
import { getPineconeClient, generateEmbedding } from '../services/pineconeService.js';
import { loadProfileSections, getProfileFilePath } from '../services/profileLoader.js';

export async function ingestProfileData(): Promise<{ success: boolean; count: number; message: string }> {
  const fileInfo = getProfileFilePath();
  const rawSections = loadProfileSections();

  if (rawSections.length === 0) {
    throw new Error(`No profile sections found in ${fileInfo.path}`);
  }

  console.log(`[Ingest] Loaded ${rawSections.length} sections from ${path.basename(fileInfo.path)} (${fileInfo.format.toUpperCase()}).`);

  const pinecone = getPineconeClient();
  if (!pinecone || !config.pinecone.apiKey) {
    console.warn('[Ingest] PINECONE_API_KEY is not set. Skipped remote upload.');
    return {
      success: true,
      count: rawSections.length,
      message: `Profile contains ${rawSections.length} sections from ${path.basename(fileInfo.path)}. (Running with local knowledge base fallback since PINECONE_API_KEY is not configured).`,
    };
  }

  try {
    const indexName = config.pinecone.indexName;
    console.log(`[Ingest] Checking Pinecone index '${indexName}'...`);

    const existingIndexes = await pinecone.listIndexes();
    const indexExists = existingIndexes.indexes?.some((idx) => idx.name === indexName);

    if (!indexExists) {
      console.log(`[Ingest] Index '${indexName}' does not exist. Creating with dimension ${config.pinecone.dimension}...`);
      await pinecone.createIndex({
        name: indexName,
        dimension: config.pinecone.dimension,
        metric: 'cosine',
        spec: {
          serverless: {
            cloud: 'aws',
            region: 'us-east-1',
          },
        },
      });
      console.log('[Ingest] Index created. Waiting 5s for initialization...');
      await new Promise((r) => setTimeout(r, 5000));
    }

    const index = pinecone.index(indexName);
    const vectors = [];

    for (let i = 0; i < rawSections.length; i++) {
      const section = rawSections[i];
      const title = section.title || `Section ${i + 1}`;

      console.log(`[Ingest] Generating embedding for [${i + 1}/${rawSections.length}]: "${title}"...`);
      const embedding = await generateEmbedding(section.text);

      vectors.push({
        id: section.id || `profile-chunk-${i + 1}`,
        values: embedding,
        metadata: {
          text: section.text,
          title,
          source: path.basename(fileInfo.path),
          ...(section.metadata || {}),
          updatedAt: new Date().toISOString(),
        },
      });
    }

    const targetNamespace = index.namespace(config.pinecone.namespace);

    // Remove stale records owned by this profile ingestion before upserting fresh vectors
    try {
      const staleIds: string[] = [];
      const prefixes = ['profile-', 'chunk-md-'];
      for (const prefix of prefixes) {
        let paginationToken: string | undefined = undefined;
        do {
          const listRes = await targetNamespace.listPaginated({ prefix, paginationToken });
          if (listRes.vectors && listRes.vectors.length > 0) {
            for (const v of listRes.vectors) {
              if (v.id) staleIds.push(v.id);
            }
          }
          paginationToken = listRes.pagination?.next;
        } while (paginationToken);
      }

      if (staleIds.length > 0) {
        console.log(`[Ingest] Removing ${staleIds.length} stale profile records from namespace '${config.pinecone.namespace}'...`);
        const batchSize = 250;
        for (let b = 0; b < staleIds.length; b += batchSize) {
          const batch = staleIds.slice(b, b + batchSize);
          await targetNamespace.deleteMany(batch);
        }
      }
    } catch (cleanErr: any) {
      console.warn('[Ingest] Warning: Could not remove prior profile records:', cleanErr?.message || cleanErr);
    }

    console.log(`[Ingest] Upserting ${vectors.length} vectors to Pinecone namespace '${config.pinecone.namespace}'...`);
    await targetNamespace.upsert(vectors);

    console.log('[Ingest] Ingestion complete successfully!');
    return {
      success: true,
      count: vectors.length,
      message: `Successfully indexed ${vectors.length} profile chunks from ${path.basename(fileInfo.path)} into Pinecone index '${indexName}'.`,
    };
  } catch (error: any) {
    console.error('[Ingest] Ingestion failed:', error);
    throw error;
  }
}

// CLI runner
if (process.argv[1]?.includes('ingest')) {
  ingestProfileData()
    .then((res) => {
      console.log(res.message);
      process.exit(0);
    })
    .catch((err) => {
      console.error('Error during ingestion:', err);
      process.exit(1);
    });
}
