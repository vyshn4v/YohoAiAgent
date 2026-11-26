import express from 'express';
import cors from 'cors';
import { config } from './config/index.js';
import { corsOptions } from './http/corsConfig.js';
import { createChatRouter } from './http/routes/chatRoutes.js';
import { createSystemRouter } from './http/routes/systemRoutes.js';
import { startEmailWorker } from './workers/emailWorker.js';

export const app = express();

app.use(cors(corsOptions));
app.use(express.json());
app.use(createSystemRouter());
app.use(createChatRouter());

// Start BullMQ background email worker alongside server in non-test environments
if (process.env.NODE_ENV !== 'test' && !process.env.DISABLE_WORKER) {
  try {
    startEmailWorker();
    console.log('[Server] Background BullMQ email worker started.');
  } catch (err: any) {
    console.warn('[Server] Could not initialize BullMQ worker (Redis may be offline):', err.message);
  }
}

if (process.env.NODE_ENV !== 'test') {
  const PORT = config.port;
  app.listen(PORT, () => {
    console.log(`=======================================================`);
    console.log(`🚀 Portfolio AI Agent Backend listening on port ${PORT}`);
    console.log(`📚 Swagger UI Docs: http://localhost:${PORT}/api/docs`);
    console.log(`📡 Endpoints:`);
    console.log(`   - POST /api/chat     (Send message to LangGraph agent)`);
    console.log(`   - GET  /api/health   (Check service connections)`);
    console.log(`   - POST /api/ingest   (Index profile to Pinecone)`);
    console.log(`   - GET  /api/enquiries(View scheduled leads)`);
    console.log(`=======================================================`);
  });
}
