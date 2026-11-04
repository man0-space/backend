import { createPrivateKey, createPublicKey, hkdfSync, type KeyObject } from 'node:crypto';
import { config } from '../config.js';

export const issuer = process.env.API_BASE_URL?.trim();
if (!issuer || new URL(issuer).protocol !== 'https:') {
  throw new Error('API_BASE_URL must be an HTTPS origin.');
}

const seed = Buffer.from(
  hkdfSync('sha256', Buffer.from(config.secret, 'hex'), Buffer.alloc(0), Buffer.from('token signing'), 32),
);

export const privateKey: KeyObject = createPrivateKey({
  key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]),
  format: 'der',
  type: 'pkcs8',
});

export const publicKey: KeyObject = createPublicKey(privateKey);

export function origin(value?: string): { origin: string; rp: string } {
  if (!value || !config.origins.includes(value)) {
    throw Object.assign(new Error('This origin is not allowed.'), { statusCode: 403 });
  }
  const url = new URL(value);
  if (url.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(url.hostname)) {
    throw Object.assign(new Error('A secure origin is required.'), { statusCode: 403 });
  }
  return { origin: value, rp: url.hostname };
}

export type AuthProvider = 'google' | 'discord' | 'github' | 'x';
export type Provider = AuthProvider | 'telegram';

export interface Spec {
  id: Provider;
  name: string;
  client: string;
  secret: string;
  linkOnly?: boolean;
}

export const providers: Spec[] = [
  { id: 'google', name: 'Google', client: 'OAUTH_GCLOUD_CLIENT_ID', secret: 'OAUTH_GCLOUD_CLIENT_SECRET' },
  { id: 'discord', name: 'Discord', client: 'OAUTH_DISCORD_CLIENT_ID', secret: 'OAUTH_DISCORD_CLIENT_SECRET' },
  { id: 'github', name: 'GitHub', client: 'OAUTH_GITHUB_CLIENT_ID', secret: 'OAUTH_GITHUB_CLIENT_SECRET' },
  { id: 'x', name: 'X', client: 'OAUTH_X_CLIENT_ID', secret: 'OAUTH_X_CLIENT_SECRET' },
  { id: 'telegram', name: 'Telegram', client: 'OAUTH_TELEGRAM_BOT_NAME', secret: 'OAUTH_TELEGRAM_ACCESS_TOKEN', linkOnly: true },
];

export const authProviders: Spec[] = providers.filter(spec => !spec.linkOnly);

export function available(spec: Spec): boolean {
  return Boolean(process.env[spec.client]?.trim() && process.env[spec.secret]?.trim());
}
