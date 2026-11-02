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

export async function cacheSet<T>(
  key: string,
  value: T,
  l2TtlSeconds = 300,
  l1TtlMs = Math.min(l2TtlSeconds * 1000, 60_000),
): Promise<void> {
  l1Set(key, value, l1TtlMs);
  try {
    await cache.set(key, JSON.stringify(value), 'EX', Math.max(1, Math.floor(l2TtlSeconds)));
  } catch {
    // Non-fatal L2 write failure; L1 still serves in-process
  }
}

export async function cacheDel(...keys: string[]): Promise<void> {
  const valid = keys.filter(Boolean);
  if (valid.length === 0) return;
  l1Del(...valid);
  try {
    await cache.del(...valid);
  } catch {
    // Non-fatal L2 delete failure
  }
}

export function singleFlight<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const existing = inflight.get(key);
  if (existing) return existing as Promise<T>;
  const promise = fn().finally(() => {
    if (inflight.get(key) === promise) {
      inflight.delete(key);
    }
  });
  inflight.set(key, promise);
  return promise;
}

export async function cached<T>(
  key: string,
  l2TtlSeconds: number,
  l1TtlMsOrFetcher: number | (() => Promise<T>),
  maybeFetcher?: () => Promise<T>,
): Promise<T> {
  const l1TtlMs =
    typeof l1TtlMsOrFetcher === 'number'
      ? l1TtlMsOrFetcher
      : Math.min(l2TtlSeconds * 1000, 60_000);
  const fetcher = typeof l1TtlMsOrFetcher === 'function' ? l1TtlMsOrFetcher : maybeFetcher!;
  const hit = await cacheGet<T>(key, l1TtlMs);
  if (hit !== undefined) return hit;
  return singleFlight(key, async () => {
    const secondHit = await cacheGet<T>(key, l1TtlMs);
    if (secondHit !== undefined) return secondHit;
    const value = await fetcher();
    await cacheSet(key, value, l2TtlSeconds, l1TtlMs);
    return value;
  });
}

export async function ready() {
  await Promise.all(
    [cache, composer].map(service =>
      service.status === 'wait' ? service.connect() : Promise.resolve(),
    ),
  );
}

export async function close() {
  l1.clear();
  inflight.clear();
  await Promise.all(
    [cache, composer].map(service =>
      service.quit().catch(() => {
        service.disconnect();
      }),
    ),
  );
}
