import { Redis, type RedisOptions } from 'ioredis';
import { config } from '../config/index.js';

const redisOptions: RedisOptions = {
  host: config.redis.host,
  port: config.redis.port,
  password: config.redis.password,
  maxRetriesPerRequest: null, // Required by BullMQ
  enableReadyCheck: false,
  lazyConnect: true,
  retryStrategy(times) {
    if (process.env.NODE_ENV === 'test') {
      return null; // Do not reconnect in test mode
    }
    const delay = Math.min(times * 1000, 5000);
    return delay;
  },
};

export function createRedisConnection(): Redis {
  if (config.redis.url) {
    return new Redis(config.redis.url, {
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
      lazyConnect: true,
    });
  }
  return new Redis(redisOptions);
}

// Default singleton client for OTP and state caching
export const redisClient = createRedisConnection();

redisClient.on('error', (err: any) => {
  if (process.env.NODE_ENV !== 'test') {
    console.warn(`[Redis Notice] Connection warning: ${err.message}`);
  }
});

redisClient.on('connect', () => {
  console.log('[Redis] Connected successfully.');
});
