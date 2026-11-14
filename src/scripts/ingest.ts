import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { config } from '../config/index.js';
import { getPineconeClient, generateEmbedding } from '../services/pineconeService.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export async function ingestProfileData(): Promise<{ success: boolean; count: number; message: string }> {
  const profilePath = path.resolve(__dirname, '../data/profile.md');

  if (!fs.existsSync(profilePath)) {
    throw new Error(`Profile file not found at ${profilePath}`);
  }

  const content = fs.readFileSync(profilePath, 'utf-8');
  // Split into sections by Markdown headers (##)
  const rawSections = content.split(/\n(?=## )/g).map((s) => s.trim()).filter(Boolean);

  console.log(`[Ingest] Found ${rawSections.length} sections to index.`);

  const pinecone = getPineconeClient();
  if (!pinecone || !config.pinecone.apiKey) {
    console.warn('[Ingest] PINECONE_API_KEY is not set. Skipped remote upload.');
    return {
      success: true,
      count: rawSections.length,
      message: `Profile contains ${rawSections.length} sections. (Running with local knowledge base fallback since PINECONE_API_KEY is not configured).`,
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
      const titleMatch = section.match(/^##\s+(.*)/m);
      const title = titleMatch ? titleMatch[1] : `Section ${i + 1}`;

      console.log(`[Ingest] Generating embedding for [${i + 1}/${rawSections.length}]: "${title}"...`);
      const embedding = await generateEmbedding(section);

      vectors.push({
        id: `profile-chunk-${i + 1}`,
        values: embedding,
        metadata: {
          text: section,
          title,
          source: 'profile.md',
          updatedAt: new Date().toISOString(),
        },
      });
    }

    console.log(`[Ingest] Upserting ${vectors.length} vectors to Pinecone namespace '${config.pinecone.namespace}'...`);
    await index.namespace(config.pinecone.namespace).upsert(vectors);

    console.log('[Ingest] Ingestion complete successfully!');
    return {
      success: true,
      count: vectors.length,
      message: `Successfully indexed ${vectors.length} profile chunks into Pinecone index '${indexName}'.`,
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
