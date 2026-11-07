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

const nearViewBody = z.object({
  contractId: z.string().trim().min(1).max(128),
  methodName: z.string().trim().min(1).max(128),
  args: z.record(z.string(), z.unknown()).optional(),
});

const nearCallBody = z.object({
  contractId: z.string().trim().min(1).max(128),
  methodName: z.string().trim().min(1).max(128),
  args: z.record(z.string(), z.unknown()).default({}),
  deposit: z.string().regex(/^\d+$/).optional(),
  gas: z.number().int().positive().max(300_000_000_000_000).optional(),
});

const spendingApproveBody = z.object({
  amountWei: z.string().regex(/^[1-9]\d*$/, 'Enter a positive amount.'),
});

const spendingReclaimBody = z.object({
  amountWei: z.string().regex(/^[1-9]\d*$/).optional(),
});

const intentsQuoteBody = z.object({
  prompt: z.string().trim().min(1).max(2000),
  dry: z.boolean().default(true),
  connectedWallets: z
    .array(
      z.object({
        network: z.enum(['evm', 'svm', 'near']),
        address: z.string().trim().min(1).max(160),
      }),
    )
    .max(20)
    .optional(),
});

const intentsGenerateBody = z.object({
  depositAddress: z.string().trim().min(1).max(256),
});

const intentsDepositBody = z.object({
  txHash: z.string().trim().min(1).max(256),
  depositAddress: z.string().trim().min(1).max(256),
  nearSenderAccount: z.string().trim().min(1).max(160).optional(),
  memo: z.string().trim().min(1).max(256).optional(),
});

const intentsStatusQuery = z.object({
  depositAddress: z.string().trim().min(1).max(256),
  depositMemo: z.string().trim().min(1).max(256).optional(),
});

const intentsSvmPrepareBody = z.object({
  senderAddress: z.string().trim().min(32).max(64),
  depositAddress: z.string().trim().min(32).max(64),
  amountAtomic: z.string().regex(/^[1-9]\d*$/, 'Enter a positive amount.'),
  tokenContract: z.string().trim().min(32).max(64).optional(),
  decimals: z.number().int().min(0).max(18).optional(),
  memo: z.string().trim().min(1).max(256).optional(),
});

const intentsSvmBroadcastBody = z.object({
  signedTransactionBase64: z.string().trim().min(80).max(8192),
  depositAddress: z.string().trim().min(32).max(64),
  memo: z.string().trim().min(1).max(256).optional(),
});

export async function nearRoutes(app: FastifyInstance) {
  app.get('/balance', async request => {
    const account = await token.read(bearer(request.headers.authorization));
    return getNearBalances(account.userAddress);
  });

  app.post('/intents/quote', async request => {
    const account = await token.read(bearer(request.headers.authorization));
    const body = intentsQuoteBody.parse(request.body);
    return resolveUserIntentQuote({
      userAddress: account.userAddress,
      prompt: body.prompt,
      dry: body.dry,
      connectedWallets: body.connectedWallets,
    });
  });

  app.post('/intents/generate', async request => {
    const account = await token.authorize(bearer(request.headers.authorization));
    const body = intentsGenerateBody.parse(request.body);
    return generateUserIntent(account.userAddress, {
      depositAddress: body.depositAddress,
    });
  });

  app.post('/intents/deposit', async request => {
    const account = await token.read(bearer(request.headers.authorization));
    const body = intentsDepositBody.parse(request.body);
    const submitted = await submitUserDepositTx({
      txHash: body.txHash,
      depositAddress: body.depositAddress,
      nearSenderAccount: body.nearSenderAccount,
      memo: body.memo,
    });
    await invalidateNearBalanceCache(account.userAddress);
    return submitted;
  });

  app.post('/intents/svm-prepare', async request => {
    await token.read(bearer(request.headers.authorization));
    const body = intentsSvmPrepareBody.parse(request.body);
    return prepareSolanaOriginTransfer({
      senderAddress: body.senderAddress,
      depositAddress: body.depositAddress,
      amountAtomic: body.amountAtomic,
      tokenContract: body.tokenContract,
      decimals: body.decimals,
      memo: body.memo,
    });
  });

  app.post('/intents/svm-broadcast', async request => {
    await token.read(bearer(request.headers.authorization));
    const body = intentsSvmBroadcastBody.parse(request.body);
    return broadcastSolanaOriginTransfer({
      signedTransactionBase64: body.signedTransactionBase64,
      depositAddress: body.depositAddress,
      memo: body.memo,
    });
  });

  app.get('/intents/status', async request => {
    await token.read(bearer(request.headers.authorization));
    const query = intentsStatusQuery.parse(request.query);
    return getUserIntentStatus({
      depositAddress: query.depositAddress,
      depositMemo: query.depositMemo,
    });
  });

  app.post('/deposit/ready', async request => {
    const account = await token.authorize(bearer(request.headers.authorization));
    return ensureDepositReady(account.userAddress);
  });

  app.post('/spending/approve', async request => {
    const account = await token.authorize(bearer(request.headers.authorization));
    const body = spendingApproveBody.parse(request.body);
    return approveSpendingLimit(account.userAddress, {
      amountWei: body.amountWei,
    });
  });

  app.post('/spending/reclaim', async request => {
    const account = await token.authorize(bearer(request.headers.authorization));
    const body = spendingReclaimBody.parse(request.body ?? {});
    return reclaimSpendingLimit(account.userAddress, {
      amountWei: body.amountWei,
    });
  });

  app.post('/view', async request => {
    const body = nearViewBody.parse(request.body);
    const result = await viewNearContract({
      contractId: body.contractId,
      methodName: body.methodName,
      args: body.args,
    });
    return { result };
  });

  app.post('/execute', async request => {
    const account = await token.authorize(bearer(request.headers.authorization));
    const body = nearCallBody.parse(request.body);
    return executeContractCall(account.userAddress, {
      contractId: body.contractId,
      methodName: body.methodName,
      args: body.args,
      deposit: body.deposit,
      gas: body.gas,
    });
  });
}
