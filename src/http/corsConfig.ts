import type { CorsOptions } from 'cors';
import type { Request, Response } from 'express';
import { config } from '../config/index.js';

const configuredOrigins: '*' | string[] =
  config.cors.origin === '*'
    ? '*'
    : config.cors.origin.split(',').map((o) => o.trim());

/**
 * Standard Express CORS configuration following OWASP origin whitelist rules.
 */
export const corsOptions: CorsOptions = {
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    if (configuredOrigins === '*') return callback(null, true);
    if (configuredOrigins.includes(origin)) return callback(null, true);
    return callback(null, false);
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: [
    'Content-Type',
    'Authorization',
    'Cache-Control',
    'X-Requested-With',
    'Accept',
  ],
  exposedHeaders: ['Content-Type'],
  credentials: configuredOrigins !== '*',
};

/**
 * Applies cross-origin headers on manual SSE responses where express cors() headers may be flushed early.
 */
export function applySseCorsHeaders(req: Request, res: Response): void {
  const requestOrigin = req.headers.origin;
  if (requestOrigin) {
    if (configuredOrigins === '*' || configuredOrigins.includes(requestOrigin)) {
      res.setHeader('Access-Control-Allow-Origin', requestOrigin);
      if (configuredOrigins !== '*') {
        res.setHeader('Access-Control-Allow-Credentials', 'true');
      }
    }
    return;
  }
  res.setHeader('Access-Control-Allow-Origin', '*');
}
