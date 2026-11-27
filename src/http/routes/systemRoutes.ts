import crypto from 'crypto';
import { NextFunction, Request, Response, Router } from 'express';
import swaggerUi from 'swagger-ui-express';
import { config } from '../../config/index.js';
import { swaggerDocument } from '../../docs/swagger.js';
import { ingestResumePdf } from '../../scripts/ingestResumePdf.js';
import { redisClient } from '../../services/redisClient.js';

function timingSafeMatch(provided: string, expected: string): boolean {
  const providedHash = crypto.createHash('sha256').update(provided).digest();
  const expectedHash = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(providedHash, expectedHash);
}

function extractAdminToken(req: Request): string {
  const apiKeyHeader = req.headers['x-api-key'];
  if (typeof apiKeyHeader === 'string' && apiKeyHeader.trim()) {
    return apiKeyHeader.trim();
  }
  const authHeader = req.headers.authorization;
  if (typeof authHeader === 'string' && authHeader.toLowerCase().startsWith('bearer ')) {
    return authHeader.slice(7).trim();
  }
  return '';
}

function requireAdminAuth(req: Request, res: Response, next: NextFunction): void {
  const configuredKey = process.env.ADMIN_API_KEY || '';
  if (!configuredKey) {
    res.status(503).json({ error: 'Admin API key is not configured.' });
    return;
  }

  const providedToken = extractAdminToken(req);
  if (!providedToken || !timingSafeMatch(providedToken, configuredKey)) {
    res.status(401).json({ error: 'Unauthorized.' });
    return;
  }

  next();
}

const DEFAULT_ENQUIRIES_LIMIT = 50;
const MAX_ENQUIRIES_LIMIT = 100;

function parsePositiveIntParam(
  raw: unknown,
  defaultValue: number,
  name: string,
  max?: number
): { valid: true; value: number } | { valid: false; error: string } {
  if (raw === undefined) {
    return { valid: true, value: defaultValue };
  }
  if (typeof raw !== 'string' || !/^\d+$/.test(raw.trim())) {
    return { valid: false, error: `Query parameter "${name}" must be a positive integer.` };
  }
  const num = Number(raw.trim());
  if (!Number.isSafeInteger(num) || num < 1 || (max !== undefined && num > max)) {
    const bound = max !== undefined ? ` between 1 and ${max}` : ' >= 1';
    return { valid: false, error: `Query parameter "${name}" must be an integer${bound}.` };
  }
  return { valid: true, value: num };
}

export function createSystemRouter(): Router {
  const router = Router();

  router.use('/api/docs', swaggerUi.serve, swaggerUi.setup(swaggerDocument));
  router.get('/api/docs.json', (_req: Request, res: Response) => {
    res.json(swaggerDocument);
  });
  router.get('/', (_req: Request, res: Response) => {
    res.redirect('/api/docs');
  });

  router.get('/api/health', async (_req: Request, res: Response) => {
    let redisStatus: string = redisClient.status;
    if (redisClient.status === 'ready') {
      try {
        const pong = await redisClient.ping();
        if (pong === 'PONG') redisStatus = 'connected';
      } catch {
        redisStatus = 'disconnected';
      }
    }

    const openrouterConfigured = Boolean(
      config.openrouter.apiKey && config.openrouter.apiKey !== 'your_openrouter_api_key_here'
    );

    res.json({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      services: {
        redis: redisStatus,
        pgvector: {
          configured: Boolean(config.postgres.url),
          dimension: config.postgres.dimension,
        },
        openrouter: {
          configured: openrouterConfigured,
          model: config.openrouter.model,
        },
        langsmith: {
          configured: Boolean(config.langsmith.apiKey),
          project: config.langsmith.project,
        },
      },
      message: 'Backend is active and ready to handle chat & scheduling requests.',
    });
  });

  router.post('/api/ingest', requireAdminAuth, async (_req: Request, res: Response) => {
    try {
      const result = await ingestResumePdf();
      if (!result.success) {
        res.status(500).json({ error: result.message, ...result });
        return;
      }
      res.json(result);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  router.get('/api/enquiries', requireAdminAuth, async (req: Request, res: Response) => {
    const pageResult = parsePositiveIntParam(req.query.page, 1, 'page');
    if (!pageResult.valid) {
      res.status(400).json({ error: pageResult.error });
      return;
    }

    const limitResult = parsePositiveIntParam(
      req.query.limit,
      DEFAULT_ENQUIRIES_LIMIT,
      'limit',
      MAX_ENQUIRIES_LIMIT
    );
    if (!limitResult.valid) {
      res.status(400).json({ error: limitResult.error });
      return;
    }

    const page = pageResult.value;
    const limit = limitResult.value;
    const start = (page - 1) * limit;
    const stop = start + limit - 1;

    try {
      const [total, ids] = await Promise.all([
        redisClient.llen('enquiries:list'),
        redisClient.lrange('enquiries:list', start, stop),
      ]);
      const enquiries: Record<string, any>[] = [];
      if (ids.length > 0) {
        const values = await redisClient.mget(ids.map((id) => `enquiry:${id}`));
        for (const data of values) {
          if (data) {
            enquiries.push(JSON.parse(data));
          }
        }
      }
      const totalPages = Math.max(1, Math.ceil(total / limit));
      const hasMore = start + ids.length < total;
      const nextPage = hasMore ? page + 1 : null;
      res.json({
        count: enquiries.length,
        page,
        limit,
        total,
        totalPages,
        hasMore,
        nextPage,
        enquiries,
      });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  return router;
}
