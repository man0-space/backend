import type { FastifyInstance } from 'fastify';
import type {
  RegistrationResponseJSON,
  AuthenticationResponseJSON,
  WebAuthnCredential,
} from '@simplewebauthn/server';
import { z } from 'zod';
import { user } from '../databases/client.js';
import { cacheDel } from '../databases/cache.js';
import { origin as checkOrigin } from './config.js';
import * as challenge from './challenge.js';
import { digest } from './digest.js';
import { startEmailVerification } from './email.js';
import * as passkey from './passkey.js';
import {
  approveSpendingLimit,
  attachExternalWallet,
  derive,
  ensureDepositReady,
  executeContractCall,
  getNearBalances,
  invalidateNearBalanceCache,
  listLinkedWallets,
  provision,
  reclaimSpendingLimit,
  viewNearContract,
} from './account.js';
import {
  broadcastSolanaOriginTransfer,
  generateUserIntent,
  getUserIntentStatus,
  prepareSolanaOriginTransfer,
  resolveUserIntentQuote,
  submitUserDepositTx,
} from '../intents.js';
import * as oauth from './oauth.js';
import * as token from './token.js';

const bearer = (authorization?: string) =>
  authorization?.startsWith('Bearer ') ? authorization.slice(7) : undefined;

const optionsBody = z.object({
  mode: z.enum(['create', 'login']),
});

const credentialBody = z.object({
  id: z.string().min(1),
  credential: z.record(z.string(), z.unknown()),
});

const emailStartBody = z.object({
  email: z.string().trim().email().max(254),
});

const emailVerifyBody = z.object({
  id: z.string().min(1),
  code: z.string().trim().regex(/^\d{6}$/, 'Enter the 6-digit verification code.'),
});

const linkAttachBody = z.object({
  network: z.enum(['evm', 'svm']),
  address: z.string().trim().min(1),
});

export async function oauthRoutes(app: FastifyInstance) {
  app.get('/:provider/start', async (request, reply) => {
    const { provider } = request.params as { provider: string };
    const { origin, mode } = request.query as { origin?: string; mode?: string };
    const oauthMode: oauth.OAuthMode = mode === 'link' ? 'link' : 'auth';
    const targetOrigin = origin || request.headers.origin;
    try {
      const url = await oauth.start(provider, targetOrigin, oauthMode);
      return reply.redirect(url);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Sign-in failed.';
      if (targetOrigin) {
        try {
          const allowed = checkOrigin(targetOrigin);
          return reply
            .type('text/html; charset=utf-8')
            .send(
              oauth.html(allowed.origin, {
                type: oauthMode === 'link' ? 'oauth-link' : 'oauth',
                ok: false,
                error: message,
              }),
            );
        } catch {
          // fall through
        }
      }
      throw err;
    }
  });

  app.get('/:provider/callback', async (request, reply) => {
    const { provider } = request.params as { provider: string };
    const query = request.query as Record<string, string | undefined>;
    if (provider === 'telegram') {
      if (!query.state) {
        throw Object.assign(new Error('Missing OAuth state parameter.'), { statusCode: 400 });
      }
      if (query.id && query.hash) {
        const result = await oauth.completeTelegram(query.state, query);
        return reply
          .type('text/html; charset=utf-8')
          .send(oauth.html(result.origin, result.payload));
      }
      return reply
        .type('text/html; charset=utf-8')
        .send(oauth.telegramCallbackHtml(query.state));
    }
    const result = await oauth.complete(
      provider,
      query.code,
      query.state,
      query.error_description || query.error,
    );
    return reply
      .type('text/html; charset=utf-8')
      .send(oauth.html(result.origin, result.payload));
  });

  app.post('/telegram/verify', async request => {
    const body = z
      .object({
        state: z.string().min(1),
        tgAuthResult: z.union([z.string(), z.record(z.string(), z.unknown())]).nullable().optional(),
      })
      .parse(request.body);
    return oauth.completeTelegram(body.state, body.tgAuthResult ?? undefined);
  });
}

export async function routes(app: FastifyInstance) {
  app.post('/passkey/options', async request => {
    const body = optionsBody.parse(request.body);
    const allowed = checkOrigin(request.headers.origin);
    const options = passkey.options(body.mode, allowed.rp);
    const id = await challenge.create({
      kind: `passkey:${body.mode}`,
      challenge: options.challenge,
      origin: allowed.origin,
      rp: allowed.rp,
    });
    return { id, options };
  });

  app.post('/passkey/register', async request => {
    const body = credentialBody.parse(request.body);
    const stored = await challenge.consume<{
      kind: string;
      challenge: string;
      origin: string;
      rp: string;
    }>(body.id);

    if (stored.kind !== 'passkey:create') {
      throw Object.assign(new Error('Invalid passkey registration challenge.'), {
        statusCode: 401,
      });
    }

    const verified = await passkey.registration(
      body.credential as unknown as RegistrationResponseJSON,
      {
        challenge: stored.challenge,
        origin: stored.origin,
        rp: stored.rp,
      },
    );

    const identityId = `passkey:${verified.credential.id}`;
    const smartKey = derive(identityId);
    const provisioned = await provision({
      key: smartKey,
      identity: { id: identityId, provider: 'passkey' },
      credential: {
        id: verified.credential.id,
        kind: 'passkey',
        proof: {
          publicKey: Buffer.from(verified.credential.publicKey).toString('base64'),
          rawKey: smartKey.toString('base64'),
          transports: verified.credential.transports ?? [],
        },
        counter: verified.credential.counter,
      },
    });

    return token.create(provisioned.userAddress);
  });

  app.post('/passkey/verify', async request => {
    const body = credentialBody.parse(request.body);
    const stored = await challenge.consume<{
      kind: string;
      challenge: string;
      origin: string;
      rp: string;
    }>(body.id);

    if (stored.kind !== 'passkey:login') {
      throw Object.assign(new Error('Invalid passkey login challenge.'), { statusCode: 401 });
    }

    const response = body.credential as unknown as AuthenticationResponseJSON;
    const [row] = await user`
      SELECT id, "userAddress", proof, counter
      FROM credentials
      WHERE id = ${response.id} AND kind = 'passkey'
    `;
    if (!row) {
      throw Object.assign(new Error('No account was found for this passkey.'), {
        statusCode: 401,
      });
    }

    const proof = row.proof as {
      publicKey: string;
      transports?: WebAuthnCredential['transports'];
    };
    const rawKeyBytes = Buffer.from(proof.publicKey, 'base64');
    const publicKeyBytes = new Uint8Array(rawKeyBytes.length);
    publicKeyBytes.set(rawKeyBytes);
    const authInfo = await passkey.authentication(response, {
      challenge: stored.challenge,
      origin: stored.origin,
      rp: stored.rp,
      credential: {
        id: row.id as string,
        publicKey: publicKeyBytes,
        counter: Number(row.counter ?? 0),
        transports: proof.transports,
      },
    });

    await user`
      UPDATE credentials SET counter = ${authInfo.newCounter} WHERE id = ${row.id}
    `;

    return token.create(row.userAddress as string);
  });

  app.post('/email/start', async request => {
    checkOrigin(request.headers.origin);
    const body = emailStartBody.parse(request.body);
    const email = body.email.toLowerCase();
    return startEmailVerification(email, challenge.create);
  });

  app.post('/email/verify', async request => {
    checkOrigin(request.headers.origin);
    const body = emailVerifyBody.parse(request.body);
    const stored = await challenge.consume<{
      kind: string;
      email: string;
      codeHash: string;
    }>(body.id);

    if (stored.kind !== 'email' || digest(body.code) !== stored.codeHash) {
      throw Object.assign(new Error('Invalid verification code.'), { statusCode: 401 });
    }

    const identityId = `email:${stored.email}`;
    const key = derive(identityId);
    const provisioned = await provision({
      key,
      identity: { id: identityId, provider: 'email' },
    });

    return token.create(provisioned.userAddress);
  });

  await app.register(oauthRoutes, { prefix: '/oauth' });

  app.post('/link', async request => {
    const account = await token.read(bearer(request.headers.authorization));
    const body = linkAttachBody.parse(request.body);
    const attached = await attachExternalWallet(account.userAddress, {
      network: body.network,
      address: body.address,
    });
    const staleKeys = [`profile:${account.userAddress.toLowerCase()}`];
    if (account.name?.trim()) {
      staleKeys.push(`profile:${account.name.trim().toLowerCase()}`);
    }
    await cacheDel(...staleKeys).catch(() => undefined);
    return attached;
  });

  app.get('/links', async request => {
    const account = await token.read(bearer(request.headers.authorization));
    return listLinkedWallets(account.userAddress);
  });
}
