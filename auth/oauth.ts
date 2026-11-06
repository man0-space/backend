import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { SocialLink } from '../schema.js';
import {
  issuer,
  origin as checkOrigin,
  providers,
  available,
  type Provider,
  type Spec,
} from './config.js';
import * as challenge from './challenge.js';
import { derive, provision } from './account.js';
import * as token from './token.js';

export type OAuthMode = 'auth' | 'link';

export interface VerifiedProviderAccount {
  subject: string;
  social: SocialLink;
  name?: string | null;
  avatar?: string | null;
}

function provider(id: string): Spec {
  const spec = providers.find(item => item.id === id);
  if (!spec) {
    throw Object.assign(new Error(`Unsupported OAuth provider: ${id}`), { statusCode: 404 });
  }
  return spec;
}

function credentials(spec: Spec): { clientId: string; clientSecret: string } {
  const clientId = process.env[spec.client]?.trim();
  const clientSecret = process.env[spec.secret]?.trim();
  if (!clientId || !clientSecret || !available(spec)) {
    throw Object.assign(new Error(`${spec.name} sign-in is currently unavailable.`), {
      statusCode: 503,
    });
  }
  return { clientId, clientSecret };
}

export async function start(
  id: string,
  originParam?: string,
  mode: OAuthMode = 'auth',
): Promise<string> {
  const spec = provider(id);
  if (spec.linkOnly && mode !== 'link') {
    throw Object.assign(new Error(`${spec.name} is only supported for profile linking.`), {
      statusCode: 400,
    });
  }
  const { clientId, clientSecret } = credentials(spec);
  const allowed = checkOrigin(originParam);
  const verifier = randomBytes(32).toString('base64url');
  const codeChallenge = createHash('sha256').update(verifier).digest('base64url');
  const state = await challenge.create({
    kind: 'oauth',
    provider: spec.id,
    origin: allowed.origin,
    verifier,
    mode,
  });
  const redirectUri = `${issuer}/api/oauth/${spec.id}/callback`;

  if (spec.id === 'telegram') {
    const botId = clientSecret.split(':')[0]?.trim();
    if (!botId) {
      throw Object.assign(new Error('Telegram bot configuration is invalid.'), {
        statusCode: 503,
      });
    }
    const returnTo = `${redirectUri}?state=${encodeURIComponent(state)}`;
    const url = new URL('https://oauth.telegram.org/auth');
    url.searchParams.set('bot_id', botId);
    url.searchParams.set('origin', issuer!);
    url.searchParams.set('embed', '1');
    url.searchParams.set('request_access', 'write');
    url.searchParams.set('return_to', returnTo);
    return url.toString();
  }

  if (spec.id === 'google') {
    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    url.searchParams.set('client_id', clientId);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', 'openid profile email');
    url.searchParams.set('state', state);
    url.searchParams.set('code_challenge', codeChallenge);
    url.searchParams.set('code_challenge_method', 'S256');
    url.searchParams.set('prompt', 'select_account');
    return url.toString();
  }

  if (spec.id === 'discord') {
    const url = new URL('https://discord.com/oauth2/authorize');
    url.searchParams.set('client_id', clientId);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', 'identify email');
    url.searchParams.set('state', state);
    url.searchParams.set('code_challenge', codeChallenge);
    url.searchParams.set('code_challenge_method', 'S256');
    return url.toString();
  }

  if (spec.id === 'github') {
    const url = new URL('https://github.com/login/oauth/authorize');
    url.searchParams.set('client_id', clientId);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('scope', 'read:user user:email');
    url.searchParams.set('state', state);
    url.searchParams.set('code_challenge', codeChallenge);
    url.searchParams.set('code_challenge_method', 'S256');
    return url.toString();
  }

  const url = new URL('https://x.com/i/oauth2/authorize');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', 'users.read tweet.read');
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return url.toString();
}

export function verifyTelegramAuthData(
  authData: Record<string, unknown>,
  botToken: string,
): VerifiedProviderAccount {
  const hash = String(authData.hash ?? '').trim();
  if (!hash || !/^[a-f0-9]+$/i.test(hash)) {
    throw Object.assign(new Error('Missing Telegram authorization hash.'), { statusCode: 401 });
  }

  const checkEntries: string[] = [];
  for (const key of Object.keys(authData).sort()) {
    if (key === 'hash' || key === 'state') continue;
    const val = authData[key];
    if (val === undefined || val === null) continue;
    checkEntries.push(`${key}=${String(val)}`);
  }
  const dataCheckString = checkEntries.join('\n');
  const secretKey = createHash('sha256').update(botToken).digest();
  const computedHash = createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(computedHash, 'hex');
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw Object.assign(new Error('Invalid Telegram authorization signature.'), { statusCode: 401 });
  }

  const subject = String(authData.id ?? '').trim();
  if (!subject) {
    throw Object.assign(new Error('Missing Telegram user ID.'), { statusCode: 401 });
  }

  const username = String(authData.username ?? '').trim().replace(/^@+/, '');
  const firstName = String(authData.first_name ?? '').trim();
  const lastName = String(authData.last_name ?? '').trim();
  const displayName = [firstName, lastName].filter(Boolean).join(' ') || username || subject;
  const handle = username ? `@${username}` : `@${subject}`;
  const url = username
    ? `https://t.me/${encodeURIComponent(username)}`
    : `https://t.me/${encodeURIComponent(subject)}`;

  return {
    subject,
    social: {
      platform: 'telegram',
      handle,
      url,
      verified: true,
      providerId: `telegram:${subject.toLowerCase()}`,
    },
    name: displayName,
    avatar: authData.photo_url ? String(authData.photo_url) : null,
  };
}
