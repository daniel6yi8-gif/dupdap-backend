import { Injectable, Logger, OnModuleInit, OnModuleDestroy, Optional } from '@nestjs/common';
import { MetricsService } from '../prometheus/metrics.service';
import Redis from 'ioredis';
import { gzipSync, gunzipSync } from 'node:zlib';

type CacheEnvelope =
  | { v: 1; encoding: 'json'; payload: string }
  | { v: 1; encoding: 'gzip+base64'; payload: string };

export interface SlidingWindowRateLimitOptions {
  limit: number;
  windowSeconds: number;
}

export interface SlidingWindowRateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetAt: number; // Unix timestamp (seconds)
  retryAfter?: number; // seconds until reset
}

/** Channel on which key-invalidation events are broadcast to all instances. */
export const CACHE_INVALIDATION_CHANNEL = 'cache:invalidate';

const compressThresholdBytes = 8 * 1024;

function buildRedisClient(): Redis {
  const url = process.env.REDIS_URL;
  if (url) return new Redis(url as any);
  return new Redis({
    host: process.env.REDIS_HOST ?? '127.0.0.1',
    port: process.env.REDIS_PORT ? Number(process.env.REDIS_PORT) : 6379,
    password: process.env.REDIS_PASSWORD || undefined,
    maxRetriesPerRequest: 3,
    enableOfflineQueue: true,
  } as any);
}

@Injectable()
export class CacheService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CacheService.name);

  /** Shared connection used for reads/writes. */
  private readonly redis: Redis;
  /** Dedicated subscriber connection (ioredis subscriber mode blocks the connection). */
  private readonly subscriber: Redis;

  /**
   * Process-local sliding-window store used when Redis is unavailable.
   * Key → timestamped member scores (seconds).
   */
  private readonly memoryWindows = new Map<string, Array<{ member: string; score: number }>>();

  /** Namespace prefix: "{env}:cache:" */
  readonly ns: string;

  constructor(@Optional() private readonly metrics?: MetricsService, redis?: Redis, subscriber?: Redis) {
    const env = process.env.NODE_ENV ?? 'development';
    this.ns = `${env}:cache:`;
    this.redis = redis ?? buildRedisClient();
    this.subscriber = subscriber ?? buildRedisClient();
  }

  private recordLookup(key: string, result: 'hit' | 'miss'): void {
    if (!this.metrics) return;
    const pattern = key.replace(/[0-9a-f-]{8,}/gi, '*');
    this.metrics.cacheRequestsTotal.inc({ key_pattern: pattern, result });
  }

  async onModuleInit(): Promise<void> {
    await this.subscriber.subscribe(CACHE_INVALIDATION_CHANNEL);
    this.subscriber.on('message', (_channel: string, message: string) => {
      // No local in-process store to clear — log for observability only.
      this.logger.debug(`Cache invalidation broadcast received: ${message}`);
    });
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.allSettled([this.redis.quit(), this.subscriber.quit()]);
  }

  // ── Key helpers ────────────────────────────────────────────────────────────

  private k(key: string): string {
    return `${this.ns}${key}`;
  }

  private stripNs(nsKey: string): string {
    return nsKey.startsWith(this.ns) ? nsKey.slice(this.ns.length) : nsKey;
  }

  // ── Encoding ───────────────────────────────────────────────────────────────

  private encode(value: unknown): string {
    const json = JSON.stringify(value);
    const bytes = Buffer.byteLength(json, 'utf8');
    const envelope: CacheEnvelope =
      bytes >= compressThresholdBytes
        ? { v: 1, encoding: 'gzip+base64', payload: gzipSync(Buffer.from(json, 'utf8')).toString('base64') }
        : { v: 1, encoding: 'json', payload: json };
    return JSON.stringify(envelope);
  }

  private decode<T>(raw: string): T | undefined {
    try {
      const envelope = JSON.parse(raw) as CacheEnvelope;
      if (envelope?.v !== 1) return undefined;
      if (envelope.encoding === 'json') return JSON.parse(envelope.payload) as T;
      if (envelope.encoding === 'gzip+base64') {
        return JSON.parse(gunzipSync(Buffer.from(envelope.payload, 'base64')).toString('utf8')) as T;
      }
      return undefined;
    } catch {
      return undefined;
    }
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  async get<T>(key: string): Promise<T | undefined> {
    const raw = await this.redis.get(this.k(key));
    if (!raw) {
      this.recordLookup(key, 'miss');
      return undefined;
    }
    const value = this.decode<T>(raw);
    this.recordLookup(key, value === undefined ? 'miss' : 'hit');
    return value;
  }

  async set<T>(key: string, value: T, options?: { ttlSeconds?: number }): Promise<void> {
    const ttl = options?.ttlSeconds ?? 86400;
    await this.redis.set(this.k(key), this.encode(value), 'EX', ttl);
  }

  async del(key: string): Promise<void> {
    await this.redis.del(this.k(key));
    await this.redis.publish(CACHE_INVALIDATION_CHANNEL, key);
  }

  async delPattern(pattern: string): Promise<number> {
    const nsPattern = this.k(pattern);
    let cursor = '0';
    let deleted = 0;
    const invalidated: string[] = [];

    do {
      const [nextCursor, keys] = await this.redis.scan(cursor, 'MATCH', nsPattern, 'COUNT', 250);
      cursor = nextCursor;
      if (keys.length) {
        deleted += await this.redis.del(...keys);
        invalidated.push(...keys.map((k) => this.stripNs(k)));
      }
    } while (cursor !== '0');

    if (invalidated.length) {
      await this.redis.publish(CACHE_INVALIDATION_CHANNEL, JSON.stringify(invalidated));
    }
    return deleted;
  }

  async flushAll(): Promise<void> {
    await this.redis.flushdb();
  }

  /** Lightweight ping using the existing connection. */
  async ping(): Promise<string> {
    return this.redis.ping();
  }

  async getOrSet<T>(
    key: string,
    fetchFn: () => Promise<T>,
    options: { ttlSeconds: number },
  ): Promise<{ value: T; cacheHit: boolean }> {
    const cached = await this.get<T>(key);
    if (cached !== undefined) return { value: cached, cacheHit: true };
    const value = await fetchFn();
    await this.set(key, value, { ttlSeconds: options.ttlSeconds });
    return { value, cacheHit: false };
  }

  /**
   * Sliding-window rate limiter backed by a Redis sorted set.
   * Falls back to an in-memory window when Redis is unavailable so API-key
   * auth degrades gracefully instead of throwing on every request.
   */
  async checkSlidingWindowRateLimit(
    key: string,
    options: SlidingWindowRateLimitOptions,
  ): Promise<SlidingWindowRateLimitResult> {
    try {
      return await this.checkSlidingWindowRateLimitRedis(key, options);
    } catch (err) {
      this.logger.warn(
        `Redis sliding-window rate limit failed for "${key}"; using in-memory fallback: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return this.checkSlidingWindowRateLimitMemory(key, options);
    }
  }

  private async checkSlidingWindowRateLimitRedis(
    key: string,
    options: SlidingWindowRateLimitOptions,
  ): Promise<SlidingWindowRateLimitResult> {
    const { limit, windowSeconds } = options;
    const now = Math.floor(Date.now() / 1000);
    const windowStart = now - windowSeconds;
    const nsKey = this.k(key);

    await this.redis.zremrangebyscore(nsKey, '-inf', windowStart);
    const count = await this.redis.zcard(nsKey);

    if (count >= limit) {
      const oldest = await this.redis.zrange(nsKey, 0, 0, 'WITHSCORES');
      const oldestScore = oldest.length >= 2 ? parseInt(oldest[1], 10) : now;
      const resetAt = oldestScore + windowSeconds;
      return {
        allowed: false,
        limit,
        remaining: 0,
        resetAt,
        retryAfter: Math.max(resetAt - now, 0),
      };
    }

    await this.redis.zadd(nsKey, now, `${now}-${Math.random()}`);
    await this.redis.expire(nsKey, windowSeconds);

    return {
      allowed: true,
      limit,
      remaining: limit - count - 1,
      resetAt: now + windowSeconds,
    };
  }

  private checkSlidingWindowRateLimitMemory(
    key: string,
    options: SlidingWindowRateLimitOptions,
  ): SlidingWindowRateLimitResult {
    const { limit, windowSeconds } = options;
    const now = Math.floor(Date.now() / 1000);
    const windowStart = now - windowSeconds;
    const nsKey = this.k(key);

    const entries = (this.memoryWindows.get(nsKey) ?? []).filter((e) => e.score > windowStart);

    if (entries.length >= limit) {
      const oldestScore = entries.reduce((min, e) => Math.min(min, e.score), entries[0].score);
      const resetAt = oldestScore + windowSeconds;
      this.memoryWindows.set(nsKey, entries);
      return {
        allowed: false,
        limit,
        remaining: 0,
        resetAt,
        retryAfter: Math.max(resetAt - now, 0),
      };
    }

    entries.push({ member: `${now}-${Math.random()}`, score: now });
    this.memoryWindows.set(nsKey, entries);

    return {
      allowed: true,
      limit,
      remaining: limit - entries.length,
      resetAt: now + windowSeconds,
    };
  }

  // ── Distributed locks ──────────────────────────────────────────────────────

  /**
   * Attempt to acquire a distributed lock keyed on `key` using Redis `SET NX PX`.
   * Returns a unique token when the lock is acquired, or `undefined` when it is
   * already held by another caller/instance.
   */
  async acquireLock(key: string, ttlMs: number): Promise<string | undefined> {
    const token = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const result = await this.redis.set(this.k(`lock:${key}`), token, 'PX', ttlMs, 'NX');
    return result === 'OK' ? token : undefined;
  }

  /**
   * Release a previously acquired lock. Only deletes the key when the stored
   * token still matches, so a lock that already expired and was re-acquired by
   * another caller is not released by mistake.
   */
  async releaseLock(key: string, token: string): Promise<void> {
    const nsKey = this.k(`lock:${key}`);
    const current = await this.redis.get(nsKey);
    if (current === token) {
      await this.redis.del(nsKey);
    }
  }
}
