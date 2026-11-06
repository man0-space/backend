import { randomBytes, createCipheriv, type KeyObject } from 'node:crypto';
import { SignJWT, jwtVerify, type JWTPayload } from 'jose';
import { config } from '../config.js';
import { cacheDel, cacheGet, cacheSet, singleFlight } from '../databases/cache.js';
import { user } from '../databases/client.js';
import type { SocialLink, User } from '../schema.js';
import { hash } from '../consent.js';
import { issuer, privateKey, publicKey } from './config.js';
import { digest } from './digest.js';
import { reconcile } from './account.js';

export const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
const SESSION_RENEW_THRESHOLD_MS = 15 * 24 * 60 * 60 * 1000;
const SESSION_L2_TTL_SECONDS = 60;
const SESSION_L1_TTL_MS = 20_000;
const RECONCILE_COOLDOWN_MS = 60_000;

const sessionKeysByUser = new Map<string, Set<string>>();
const reconcileFailureUntil = new Map<string, number>();

function sessionCacheKey(tokenDigest: string): string {
  return `auth:session:${tokenDigest}`;
}

function trackUserSessionKey(userAddress: string, cacheKey: string): void {
  const lower = userAddress.toLowerCase();
  let set = sessionKeysByUser.get(lower);
  if (!set) {
    set = new Set();
    sessionKeysByUser.set(lower, set);
  }
  set.add(cacheKey);
}

export async function invalidateUserSessions(
  userAddress: string,
  rawToken?: string,
): Promise<void> {
  const lower = userAddress.trim().toLowerCase();
  const keys = new Set<string>(sessionKeysByUser.get(lower) ?? []);
  sessionKeysByUser.delete(lower);
  if (rawToken) {
    keys.add(sessionCacheKey(digest(rawToken)));
  }
  if (keys.size > 0) {
    await cacheDel(...keys);
  }
}

function scheduleBackgroundReconcile(userAddress: string): void {
  const cooldownUntil = reconcileFailureUntil.get(userAddress) ?? 0;
  if (Date.now() < cooldownUntil) return;
  void singleFlight(`reconcile:bg:${userAddress}`, async () => {
    const res = await reconcile(userAddress).catch(() => ({ status: 'failed' }));
    if (res.status !== 'active') {
      reconcileFailureUntil.set(userAddress, Date.now() + RECONCILE_COOLDOWN_MS);
    } else {
      reconcileFailureUntil.delete(userAddress);
    }
  });
}

let userColsReady = false;
export async function ensureUserColumns(): Promise<void> {
  if (userColsReady) return;
  await user.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS banner text`);
  await user.query(
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS socials jsonb NOT NULL DEFAULT '[]'::jsonb`,
  );
  userColsReady = true;
}

export function normalizeUserRow(row: Record<string, unknown>, consented: boolean): User {
  return {
    userAddress: String(row.userAddress),
    name: String(row.name ?? ''),
    bio: String(row.bio ?? ''),
    image: row.image ? String(row.image) : null,
    banner: row.banner ? String(row.banner) : null,
    socials: Array.isArray(row.socials) ? (row.socials as SocialLink[]) : [],
    consented,
  };
}

export async function sign(
  key: KeyObject,
  iss: string,
  subject: string,
  jti: string,
  ttlSeconds: number,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({})
    .setProtectedHeader({ alg: 'EdDSA' })
    .setIssuer(iss)
    .setAudience(iss)
    .setSubject(subject)
    .setJti(jti)
    .setIssuedAt(now)
    .setExpirationTime(now + ttlSeconds)
    .sign(key);
}

export async function verify(
  value: string,
  key: KeyObject,
  iss: string,
): Promise<JWTPayload> {
  const { payload } = await jwtVerify(value, key, {
    algorithms: ['EdDSA'],
    issuer: iss,
    audience: iss,
  });
  if (!payload.sub || !payload.jti) {
    throw new Error('Invalid token claims.');
  }
  return payload;
}

function encrypt(value: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(config.secret, 'hex'), iv);
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64');
}

export async function create(userAddress: string) {
  await ensureUserColumns();
  const rec = await reconcile(userAddress);
  const expires = new Date(Date.now() + SESSION_TTL_SECONDS * 1000).toISOString();
  const value = await sign(
    privateKey,
    issuer!,
    userAddress,
    randomBytes(32).toString('base64url'),
    SESSION_TTL_SECONDS,
  );
  const tokenHash = digest(value);
  await user`
    INSERT INTO tokens(id, "userAddress", jwt, expires)
    VALUES (${tokenHash}, ${userAddress}, ${encrypt(value)}, ${expires})
  `;
  const [row] = await user`
    SELECT u."userAddress", u.name, u.bio, u.image, u.banner, u.socials,
      EXISTS(
        SELECT 1 FROM consents c
        WHERE c."userAddress" = u."userAddress" AND c.policy = ${hash}
      ) AS consented
    FROM users u
    WHERE u."userAddress" = ${userAddress}
  `;
  const normalized = normalizeUserRow(row, Boolean(row?.consented));
  if (rec.status === 'active') {
    const key = sessionCacheKey(tokenHash);
    trackUserSessionKey(userAddress, key);
    await cacheSet(key, normalized, SESSION_L2_TTL_SECONDS, SESSION_L1_TTL_MS);
  }
  return { token: value, user: normalized, expires };
}
