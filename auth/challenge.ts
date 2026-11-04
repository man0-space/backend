import { randomBytes } from 'node:crypto';
import { cache } from '../databases/cache.js';
import { digest } from './digest.js';

export async function create(value: unknown): Promise<string> {
  const id = randomBytes(32).toString('base64url');
  await cache.set(`challenge:${digest(id)}`, JSON.stringify(value), 'EX', 300, 'NX');
  return id;
}

export async function peek<T = Record<string, unknown>>(id: string): Promise<T> {
  if (!/^[\w-]{43}$/.test(id)) {
    throw Object.assign(new Error('Invalid authentication challenge.'), { statusCode: 401 });
  }
  const value = await cache.get(`challenge:${digest(id)}`);
  if (!value) {
    throw Object.assign(new Error('The authentication request expired or was already used.'), {
      statusCode: 401,
    });
  }
  return JSON.parse(value) as T;
}

export async function consume<T = Record<string, unknown>>(id: string): Promise<T> {
  if (!/^[\w-]{43}$/.test(id)) {
    throw Object.assign(new Error('Invalid authentication challenge.'), { statusCode: 401 });
  }
  const value = await cache.getdel(`challenge:${digest(id)}`);
  if (!value) {
    throw Object.assign(new Error('The authentication request expired or was already used.'), {
      statusCode: 401,
    });
  }
  return JSON.parse(value) as T;
}
