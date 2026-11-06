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

export async function exchange(
  id: Exclude<Provider, 'telegram'>,
  code: string,
  verifier: string,
): Promise<VerifiedProviderAccount> {
  const spec = provider(id);
  const { clientId, clientSecret } = credentials(spec);
  const redirectUri = `${issuer}/api/oauth/${spec.id}/callback`;

  if (spec.id === 'google') {
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        code,
        code_verifier: verifier,
        grant_type: 'authorization_code',
        redirect_uri: redirectUri,
      }),
    });
    if (!tokenRes.ok) {
      throw Object.assign(new Error('Google authentication failed.'), { statusCode: 401 });
    }
    const tokenData = (await tokenRes.json()) as { access_token?: string };
    const profileRes = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
      headers: { authorization: `Bearer ${tokenData.access_token}` },
    });
    if (!profileRes.ok) {
      throw Object.assign(new Error('Failed to verify Google account.'), { statusCode: 401 });
    }
    const profile = (await profileRes.json()) as {
      sub?: string;
      email?: string;
      name?: string;
      picture?: string;
    };
    if (!profile.sub) {
      throw Object.assign(new Error('Google account is missing subject ID.'), { statusCode: 401 });
    }
    const subject = String(profile.sub);
    const email = String(profile.email ?? '').trim();
    const handle = email || String(profile.name ?? '').trim() || subject;
    const url = email ? `mailto:${email}` : 'https://accounts.google.com';
    return {
      subject,
      social: {
        platform: 'google',
        handle,
        url,
        verified: true,
        providerId: `google:${(email || subject).toLowerCase()}`,
      },
      name: profile.name ? String(profile.name) : null,
      avatar: profile.picture ? String(profile.picture) : null,
    };
  }

  if (spec.id === 'discord') {
    const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        code,
        code_verifier: verifier,
        grant_type: 'authorization_code',
        redirect_uri: redirectUri,
      }),
    });
    if (!tokenRes.ok) {
      throw Object.assign(new Error('Discord authentication failed.'), { statusCode: 401 });
    }
    const tokenData = (await tokenRes.json()) as { access_token?: string };
    const profileRes = await fetch('https://discord.com/api/users/@me', {
      headers: { authorization: `Bearer ${tokenData.access_token}` },
    });
    if (!profileRes.ok) {
      throw Object.assign(new Error('Failed to verify Discord account.'), { statusCode: 401 });
    }
    const profile = (await profileRes.json()) as {
      id?: string;
      username?: string;
      global_name?: string;
      avatar?: string;
    };
    if (!profile.id) {
      throw Object.assign(new Error('Discord account is missing user ID.'), { statusCode: 401 });
    }
    const subject = String(profile.id);
    const username = String(profile.username ?? subject).trim().replace(/^@+/, '');
    return {
      subject,
      social: {
        platform: 'discord',
        handle: `@${username}`,
        url: `https://discord.com/users/${encodeURIComponent(subject)}`,
        verified: true,
        providerId: `discord:${subject.toLowerCase()}`,
      },
      name: profile.global_name ? String(profile.global_name) : username,
      avatar: profile.avatar
        ? `https://cdn.discordapp.com/avatars/${subject}/${profile.avatar}.png`
        : null,
    };
  }

  if (spec.id === 'github') {
    const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        code,
        code_verifier: verifier,
        redirect_uri: redirectUri,
      }),
    });
    if (!tokenRes.ok) {
      throw Object.assign(new Error('GitHub authentication failed.'), { statusCode: 401 });
    }
    const tokenData = (await tokenRes.json()) as { access_token?: string };
    if (!tokenData.access_token) {
      throw Object.assign(new Error('GitHub token exchange failed.'), { statusCode: 401 });
    }
    const profileRes = await fetch('https://api.github.com/user', {
      headers: {
        authorization: `Bearer ${tokenData.access_token}`,
        'user-agent': 'oauth',
        accept: 'application/vnd.github+json',
      },
    });
    if (!profileRes.ok) {
      throw Object.assign(new Error('Failed to verify GitHub account.'), { statusCode: 401 });
    }
    const profile = (await profileRes.json()) as {
      id?: number | string;
      login?: string;
      name?: string;
      avatar_url?: string;
    };
    if (!profile.id) {
      throw Object.assign(new Error('GitHub account is missing user ID.'), { statusCode: 401 });
    }
    const subject = String(profile.id);
    const login = String(profile.login ?? subject).trim().replace(/^@+/, '');
    return {
      subject,
      social: {
        platform: 'github',
        handle: `@${login}`,
        url: `https://github.com/${encodeURIComponent(login)}`,
        verified: true,
        providerId: `github:${login.toLowerCase()}`,
      },
      name: profile.name ? String(profile.name) : login,
      avatar: profile.avatar_url ? String(profile.avatar_url) : null,
    };
  }

  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const tokenRes = await fetch('https://api.x.com/2/oauth2/token', {
    method: 'POST',
    headers: {
      authorization: `Basic ${basic}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      code,
      code_verifier: verifier,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri,
    }),
  });
  if (!tokenRes.ok) {
    throw Object.assign(new Error('X authentication failed.'), { statusCode: 401 });
  }
  const tokenData = (await tokenRes.json()) as { access_token?: string };
  const profileRes = await fetch(
    'https://api.x.com/2/users/me?user.fields=id,name,username,profile_image_url',
    {
      headers: { authorization: `Bearer ${tokenData.access_token}` },
    },
  );
  if (!profileRes.ok) {
    throw Object.assign(new Error('Failed to verify X account.'), { statusCode: 401 });
  }
  const body = (await profileRes.json()) as {
    data?: { id?: string; username?: string; name?: string; profile_image_url?: string };
  };
  if (!body.data?.id) {
    throw Object.assign(new Error('X account is missing user ID.'), { statusCode: 401 });
  }
  const subject = String(body.data.id);
  const username = String(body.data.username ?? subject).trim().replace(/^@+/, '');
  return {
    subject,
    social: {
      platform: 'x',
      handle: `@${username}`,
      url: `https://x.com/${encodeURIComponent(username)}`,
      verified: true,
      providerId: `x:${username.toLowerCase()}`,
    },
    name: body.data.name ? String(body.data.name) : username,
    avatar: body.data.profile_image_url ? String(body.data.profile_image_url) : null,
  };
}
