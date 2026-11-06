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
