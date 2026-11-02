import { Redis } from 'ioredis';
import { config } from '../config.js';

const options = {
  lazyConnect: true,
  enableOfflineQueue: true,
  maxRetriesPerRequest: 3,
  connectTimeout: 10000,
  commandTimeout: 10000,
  keepAlive: 30000,
  retryStrategy: (times: number) => Math.min(times * 100, 3000),
};

export const cache = new Redis(config.cache, options);
export const composer = new Redis(config.composer, options);

for (const service of [cache, composer]) {
  service.on('error', () => {});
}

interface L1Entry {
  value: unknown;
  expiresAt: number;
}

const MAX_L1_ENTRIES = 10_000;
const l1 = new Map<string, L1Entry>();
const inflight = new Map<string, Promise<unknown>>();

export function l1Get<T>(key: string): T | undefined {
  const entry = l1.get(key);
  if (!entry) return undefined;
  if (entry.expiresAt <= Date.now()) {
    l1.delete(key);
    return undefined;
  }
  return entry.value as T;
}

export function l1Set<T>(key: string, value: T, ttlMs: number): void {
  if (l1.size >= MAX_L1_ENTRIES && !l1.has(key)) {
    const oldestKey = l1.keys().next().value;
    if (oldestKey !== undefined) l1.delete(oldestKey);
  }
  l1.set(key, { value, expiresAt: Date.now() + ttlMs });
}

export function l1Del(...keys: string[]): void {
  for (const key of keys) {
    if (key) l1.delete(key);
  }
}

export async function cacheGet<T>(key: string, l1TtlMs = 30_000): Promise<T | undefined> {
  const hit = l1Get<T>(key);
  if (hit !== undefined) return hit;
  try {
    const raw = await cache.get(key);
    if (raw === null || raw === undefined) return undefined;
    const parsed = JSON.parse(raw) as T;
    l1Set(key, parsed, l1TtlMs);
    return parsed;
  } catch {
    return undefined;
  }
}

export async function cacheMGet<T>(keys: string[], l1TtlMs = 30_000): Promise<Map<string, T>> {
  const result = new Map<string, T>();
  if (keys.length === 0) return result;
  const missing: string[] = [];
  for (const key of keys) {
    const hit = l1Get<T>(key);
    if (hit !== undefined) {
      result.set(key, hit);
    } else {
      missing.push(key);
    }
  }
  if (missing.length === 0) return result;
  try {
    const raws = await cache.mget(...missing);
    for (let i = 0; i < missing.length; i++) {
      const raw = raws[i];
      const key = missing[i]!;
      if (raw !== null && raw !== undefined) {
        const parsed = JSON.parse(raw) as T;
        l1Set(key, parsed, l1TtlMs);
        result.set(key, parsed);
      }
    }
  } catch {
    // Non-fatal L2 read failure
  }
  return result;
}
