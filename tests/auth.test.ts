import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createHash, randomBytes, randomUUID } from 'node:crypto';
import { isoCBOR } from '@simplewebauthn/server/helpers';
import { base58 } from '@scure/base';
import { p256 } from '@noble/curves/nist.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { ed25519 } from '@noble/curves/ed25519.js';
import { OneClickService } from '@defuse-protocol/one-click-sdk-typescript';
import { ready, composer } from '../databases/cache.js';
import { user, workflow } from '../databases/client.js';
import { config, rpcFor, usdcFor } from '../config.js';
import { build } from '../server.js';
import {
  codeFor,
  derive,
  prepare,
} from '../auth/account.js';
import {
  extractStateKey,
  keccak256,
} from '../auth/protocol.js';
import { digest } from '../auth/digest.js';
import { accept as acceptConsent, hash as policyHash } from '../consent.js';
import { issuer, privateKey } from '../auth/config.js';
import { SESSION_TTL_SECONDS, sign as signJwt } from '../auth/token.js';

let app: Awaited<ReturnType<typeof build>>;
const createdWallets = new Set<string>();
const originalFetch = globalThis.fetch;
const originalResendKey = process.env.RESEND_API_KEY;
const deliveredEmailCodes = new Map<string, string>();

interface MockChainState {
  initializedAccounts: Map<
    string,
    {
      code: string;
      ownerKeyB58: string;
      amount: string;
    }
  >;
  intentsKeys: Map<string, Set<string>>;
  mtBalances: Map<string, string>;
  ftBalances: Map<string, string>;
  broadcastCalls: Array<{ receiverId: string; txText: string }>;
  depositSubmittedTxs: Array<{ txHash: string; depositAddress: string }>;
  failBroadcastCount: number;
  skipHasPublicKeyCount: number;
}

const mockChain: MockChainState = {
  initializedAccounts: new Map(),
  intentsKeys: new Map(),
  mtBalances: new Map(),
  ftBalances: new Map(),
  broadcastCalls: [],
  depositSubmittedTxs: [],
  failBroadcastCount: 0,
  skipHasPublicKeyCount: 0,
};

function registerExpectedWalletOnMock(wallet: string, compressedKey: Uint8Array, code = codeFor()) {
  mockChain.initializedAccounts.set(wallet, {
    code,
    ownerKeyB58: `p256:${base58.encode(compressedKey)}`,
    amount: '0',
  });
}

before(async () => {
  process.env.RESEND_API_KEY = 'resend-test-key';
  await ready();
  app = await build();

  globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (url === 'https://api.resend.com/emails') {
      const body = JSON.parse(String(init?.body || '{}')) as { to: string[]; subject: string };
      const code = body.subject.match(/^\d{6}/)?.[0];
      assert.ok(code);
      deliveredEmailCodes.set(body.to[0]!, code);
      return new Response('{"id":"email-fixture"}', { status: 200 });
    }
    if (url.endsWith('/deposit/submit')) {
      const body = JSON.parse(String(init?.body || '{}')) as {
        txHash: string;
        depositAddress: string;
      };
      mockChain.depositSubmittedTxs.push(body);
      return new Response(JSON.stringify({ status: 'OK' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url.endsWith('/v0/tokens')) {
      return new Response('[]', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (
      url === rpcFor('mainnet') ||
      url === rpcFor('testnet') ||
      url.includes('fastnear.com') ||
      url.includes('near.org') ||
      url.includes('quiknode.pro') ||
      url.includes('pagoda.co')
    ) {
      const body = JSON.parse(String(init?.body || '{}')) as {
        method?: string;
        params?: Record<string, unknown> | string[];
      };

      if (body.method === 'query' && !Array.isArray(body.params)) {
        const reqType = body.params?.request_type;
        const accountId = String(body.params?.account_id || '');

        if (reqType === 'view_access_key') {
          return new Response(
            JSON.stringify({
              jsonrpc: '2.0',
              id: '1',
              result: {
                nonce: 100,
                block_hash: base58.encode(Buffer.alloc(32, 9)),
              },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }

        if (reqType === 'view_account') {
          const entry = mockChain.initializedAccounts.get(accountId);
          if (!entry) {
            return new Response(
              JSON.stringify({
                jsonrpc: '2.0',
                id: '1',
                error: {
                  message: `Account ${accountId} does not exist while viewing`,
                  cause: { name: 'UNKNOWN_ACCOUNT' },
                },
              }),
              { status: 200, headers: { 'content-type': 'application/json' } },
            );
          }
          return new Response(
            JSON.stringify({
              jsonrpc: '2.0',
              id: '1',
              result: {
                amount: entry.amount,
                locked: '0',
                code_hash: '11111111111111111111111111111111',
                storage_usage: 244,
                global_contract_account_id: entry.code.startsWith('0s') ? entry.code : undefined,
                global_contract_hash: !entry.code.startsWith('0s') ? entry.code : undefined,
              },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }

        if (reqType === 'call_function') {
          const methodName = String(body.params?.method_name || '');
          const argsJson = body.params?.args_base64
            ? JSON.parse(Buffer.from(String(body.params.args_base64), 'base64').toString('utf8'))
            : {};

          if (methodName === 'w_public_key') {
            const entry = mockChain.initializedAccounts.get(accountId);
            const resultBytes = Array.from(
              Buffer.from(JSON.stringify(entry?.ownerKeyB58 ?? null), 'utf8'),
            );
            return new Response(
              JSON.stringify({ jsonrpc: '2.0', id: '1', result: { result: resultBytes } }),
              { status: 200, headers: { 'content-type': 'application/json' } },
            );
          }

          if (methodName === 'w_nonce') {
            const resultBytes = Array.from(Buffer.from(JSON.stringify(0), 'utf8'));
            return new Response(
              JSON.stringify({ jsonrpc: '2.0', id: '1', result: { result: resultBytes } }),
              { status: 200, headers: { 'content-type': 'application/json' } },
            );
          }

          const isVerifierContract =
            accountId === 'intents.near' || accountId === 'verifier.tidepool-sandbox.testnet';

          if (isVerifierContract && methodName === 'has_public_key') {
            if (mockChain.skipHasPublicKeyCount > 0) {
              mockChain.skipHasPublicKeyCount--;
              const falseBytes = Array.from(Buffer.from('false', 'utf8'));
              return new Response(
                JSON.stringify({ jsonrpc: '2.0', id: '1', result: { result: falseBytes } }),
                { status: 200, headers: { 'content-type': 'application/json' } },
              );
            }
            const targetAcct = String(argsJson.account_id || '');
            const pubKey = String(argsJson.public_key || '');
            const has = mockChain.intentsKeys.get(targetAcct)?.has(pubKey) ?? false;
            const resultBytes = Array.from(Buffer.from(JSON.stringify(has), 'utf8'));
            return new Response(
              JSON.stringify({ jsonrpc: '2.0', id: '1', result: { result: resultBytes } }),
              { status: 200, headers: { 'content-type': 'application/json' } },
            );
          }

          if (isVerifierContract && methodName === 'public_keys_of') {
            const targetAcct = String(argsJson.account_id || '');
            const keys = Array.from(mockChain.intentsKeys.get(targetAcct) ?? []);
            const resultBytes = Array.from(Buffer.from(JSON.stringify(keys), 'utf8'));
            return new Response(
              JSON.stringify({ jsonrpc: '2.0', id: '1', result: { result: resultBytes } }),
              { status: 200, headers: { 'content-type': 'application/json' } },
            );
          }

          if (isVerifierContract && methodName === 'mt_balance_of') {
            const targetAcct = String(argsJson.account_id || '');
            const tokenId = String(argsJson.token_id || '');
            const bal = mockChain.mtBalances.get(`${targetAcct}:${tokenId}`) ?? '0';
            const resultBytes = Array.from(Buffer.from(JSON.stringify(bal), 'utf8'));
            return new Response(
              JSON.stringify({ jsonrpc: '2.0', id: '1', result: { result: resultBytes } }),
              { status: 200, headers: { 'content-type': 'application/json' } },
            );
          }

          if (methodName === 'ft_balance_of') {
            const targetAcct = String(argsJson.account_id || '');
            const bal = mockChain.ftBalances.get(`${accountId}:${targetAcct}`) ?? '0';
            const resultBytes = Array.from(Buffer.from(JSON.stringify(bal), 'utf8'));
            return new Response(
              JSON.stringify({ jsonrpc: '2.0', id: '1', result: { result: resultBytes } }),
              { status: 200, headers: { 'content-type': 'application/json' } },
            );
          }

          if (methodName === 'storage_balance_of') {
            const resultBytes = Array.from(
              Buffer.from(JSON.stringify({ total: '1250000000000000000000', available: '0' }), 'utf8'),
            );
            return new Response(
              JSON.stringify({ jsonrpc: '2.0', id: '1', result: { result: resultBytes } }),
              { status: 200, headers: { 'content-type': 'application/json' } },
            );
          }
        }
      }

      if (body.method === 'broadcast_tx_commit' && Array.isArray(body.params)) {
        if (mockChain.failBroadcastCount > 0) {
          mockChain.failBroadcastCount--;
          return new Response(
            JSON.stringify({
              jsonrpc: '2.0',
              id: '1',
              error: { message: 'Simulated transient RPC broadcast failure' },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }

        const signedBytes = Buffer.from(String(body.params[0]), 'base64');
        const signerLen = signedBytes.readUInt32LE(0);
        const receiverOffset = 4 + signerLen + 1 + 32 + 8;
        const receiverLen = signedBytes.readUInt32LE(receiverOffset);
        const receiverId = signedBytes
          .subarray(receiverOffset + 4, receiverOffset + 4 + receiverLen)
          .toString('utf8');
        const txText = signedBytes.toString('latin1');
        mockChain.broadcastCalls.push({ receiverId, txText });

        // Simulate ft_withdraw moving USDC from intents.near mt_balance_of to receiver NEP-141 balance
        if (txText.includes('ft_withdraw')) {
          const allArgs = [...txText.matchAll(/"args":"([A-Za-z0-9+/=]+)"/g)];
          for (const m of allArgs) {
            try {
              const parsedArgs = JSON.parse(Buffer.from(m[1]!, 'base64').toString('utf8')) as {
                token?: string;
                receiver_id?: string;
                amount?: string;
              };
              const signerMatch = txText.match(/"signer_id":"([^"]+)"/);
              if (parsedArgs.token && parsedArgs.receiver_id && parsedArgs.amount && signerMatch) {
                const mtKey = `${signerMatch[1]}:nep141:${parsedArgs.token}`;
                const prevMt = BigInt(mockChain.mtBalances.get(mtKey) ?? '0');
                const amt = BigInt(parsedArgs.amount);
                mockChain.mtBalances.set(mtKey, (prevMt > amt ? prevMt - amt : 0n).toString());
                const ftKey = `${parsedArgs.token}:${parsedArgs.receiver_id}`;
                const prevFt = BigInt(mockChain.ftBalances.get(ftKey) ?? '0');
                mockChain.ftBalances.set(ftKey, (prevFt + amt).toString());
              }
            } catch {
              // ignore non-JSON args
            }
          }
        }

        // Check if transaction initializes a 0u account in Postgres `accounts`
        if (receiverId.startsWith('0u')) {
          const [r] = await user`
            SELECT "userAddress", state, code FROM accounts WHERE "userAddress" = ${receiverId}
          `;
          if (r) {
            const rawInit = Buffer.from(r.state as string, 'base64');
            const keySlice = extractStateKey(rawInit);
            registerExpectedWalletOnMock(receiverId, keySlice, r.code as string);
          }
        }

        // Check if transaction registers a key on intents.near via add_public_key or execute_intents
        const addKeyMatch = txText.match(/"args":"([A-Za-z0-9+/=]+)"/);
        if (addKeyMatch) {
          try {
            const decodedArgs = JSON.parse(
              Buffer.from(addKeyMatch[1], 'base64').toString('utf8'),
            ) as { public_key?: string };
            const signerMatch = txText.match(/"signer_id":"(0u[0-9a-z]+)"/);
            if (decodedArgs.public_key && signerMatch) {
              const set = mockChain.intentsKeys.get(signerMatch[1]) ?? new Set<string>();
              set.add(decodedArgs.public_key);
              mockChain.intentsKeys.set(signerMatch[1], set);
            }
          } catch {
            // ignore non-JSON args
          }
        }
        const intentMatch = txText.match(/\\"signer_id\\":\\"(0u[0-9a-z]+)\\".*?\\"public_key\\":\\"((?:p256|secp256k1|ed25519):[A-Za-z0-9]+)\\"/);
        if (intentMatch) {
          const set = mockChain.intentsKeys.get(intentMatch[1]) ?? new Set<string>();
          set.add(intentMatch[2]);
          mockChain.intentsKeys.set(intentMatch[1], set);
        }

        const txHash = base58.encode(createHash('sha256').update(signedBytes).digest());
        return new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: '1',
            result: {
              status: { SuccessValue: '' },
              transaction: { hash: txHash },
              transaction_outcome: { id: txHash, outcome: { status: { SuccessValue: '' } } },
              receipts_outcome: [],
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
    }
    return originalFetch(input as string, init);
  };
});

after(async () => {
  globalThis.fetch = originalFetch;
  if (originalResendKey === undefined) delete process.env.RESEND_API_KEY;
  else process.env.RESEND_API_KEY = originalResendKey;
  for (const wallet of createdWallets) {
    await workflow`DELETE FROM workflows WHERE "userAddress" = ${wallet}`;
    await user`DELETE FROM links WHERE "userAddress" = ${wallet}`;
    await user`DELETE FROM tokens WHERE "userAddress" = ${wallet}`;
    await user`DELETE FROM credentials WHERE "userAddress" = ${wallet}`;
    await user`DELETE FROM identities WHERE "userAddress" = ${wallet}`;
    await user`DELETE FROM consents WHERE "userAddress" = ${wallet}`;
    await user`DELETE FROM accounts WHERE "userAddress" = ${wallet}`;
    await user`DELETE FROM users WHERE "userAddress" = ${wallet}`;
    await composer.del(`draft:${digest(wallet)}:active`);
  }
  await app.close();
});

test('synthetic passkey registration provisions and activates a native 0u Universal Account', async () => {
  const origin = 'http://localhost:4001';
  const optionsRes = await app.inject({
    method: 'POST',
    url: '/api/auth/passkey/options',
    headers: { origin },
    payload: { mode: 'create' },
  });
  assert.equal(optionsRes.statusCode, 200);
  const { id, options } = optionsRes.json() as {
    id: string;
    options: { challenge: string };
  };

  const { publicKey: ecPub } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = ecPub.export({ format: 'jwk' });
  const cose = isoCBOR.encode(
    new Map<number, unknown>([
      [1, 2],
      [3, -7],
      [-1, 1],
      [-2, Buffer.from(jwk.x!, 'base64url')],
      [-3, Buffer.from(jwk.y!, 'base64url')],
    ]),
  );
  const credentialId = randomBytes(32);
  const len = Buffer.alloc(2);
  len.writeUInt16BE(credentialId.length);
  const authData = Buffer.concat([
    createHash('sha256').update('localhost').digest(),
    Buffer.from([0x45]),
    Buffer.alloc(4),
    Buffer.alloc(16),
    len,
    credentialId,
    cose,
  ]);
  const clientDataJSON = Buffer.from(
    JSON.stringify({
      type: 'webauthn.create',
      challenge: options.challenge,
      origin,
      crossOrigin: false,
    }),
  ).toString('base64url');
  const attestationObject = Buffer.from(
    isoCBOR.encode(
      new Map<string, unknown>([
        ['fmt', 'none'],
        ['attStmt', new Map()],
        ['authData', authData],
      ]),
    ),
  ).toString('base64url');

  const registerRes = await app.inject({
    method: 'POST',
    url: '/api/auth/passkey/register',
    headers: { origin },
    payload: {
      id,
      credential: {
        id: credentialId.toString('base64url'),
        rawId: credentialId.toString('base64url'),
        type: 'public-key',
        clientExtensionResults: {},
        response: {
          clientDataJSON,
          attestationObject,
        },
      },
    },
  });
  assert.equal(registerRes.statusCode, 200);
  const body = registerRes.json() as {
    token: string;
    expires: string;
    user: { userAddress: string; name: string; bio: string; image: string | null };
  };
  assert.equal(SESSION_TTL_SECONDS, 30 * 24 * 60 * 60);
  assert.ok(
    Date.parse(body.expires) - Date.now() > 29 * 24 * 60 * 60 * 1000,
    'Expected 30-day session expiration',
  );
  assert.match(body.user.userAddress, /^0u[0123456789abcdefghjkmnpqrstvwxyz]{52}$/);
  createdWallets.add(body.user.userAddress);
  assert.equal(body.user.name, '');
  assert.equal(body.user.bio, '');
  assert.equal(body.user.image, null);

  const [accountRow] = await user`
    SELECT * FROM accounts WHERE "userAddress" = ${body.user.userAddress}
  `;
  assert.ok(accountRow);
  assert.equal(accountRow.code, codeFor());
  assert.equal(accountRow.status, 'active');
  assert.ok(accountRow.transaction);
  assert.ok(Buffer.from(accountRow.state as string, 'base64').length <= 770);
});

test('email verification provisions an active deterministic 0u Universal Account and retries failed activation on GET /api/user without losing the user', async () => {
  const origin = 'http://localhost:4001';
  const email = `creator-${randomUUID().slice(0, 8)}@man0.space`;
  const startRes = await app.inject({
    method: 'POST',
    url: '/api/auth/email/start',
    headers: { origin },
    payload: { email },
  });
  assert.equal(startRes.statusCode, 200);
  const startData = startRes.json() as { id: string; code?: string };
  assert.equal(startData.code, undefined);
  const deliveredCode = deliveredEmailCodes.get(email);
  assert.ok(deliveredCode);

  // Force the first on-chain broadcast to fail during login
  mockChain.failBroadcastCount = 1;

  const verifyRes = await app.inject({
    method: 'POST',
    url: '/api/auth/email/verify',
    headers: { origin },
    payload: {
      id: startData.id,
      code: deliveredCode,
    },
  });
  assert.equal(verifyRes.statusCode, 200);
  const verifyData = verifyRes.json() as {
    token: string;
    user: { userAddress: string; name: string };
  };
  const wallet = verifyData.user.userAddress;
  createdWallets.add(wallet);
  assert.match(wallet, /^0u[0123456789abcdefghjkmnpqrstvwxyz]{52}$/);

  const [failedAccount] = await user`
    SELECT status FROM accounts WHERE "userAddress" = ${wallet}
  `;
  assert.equal(failedAccount.status, 'failed');

  // Calling GET /api/user retries activation and transitions status -> 'active'
  const userRes = await app.inject({
    method: 'GET',
    url: '/api/user',
    headers: { authorization: `Bearer ${verifyData.token}` },
  });
  assert.equal(userRes.statusCode, 200);
  assert.equal(userRes.json().userAddress, wallet);

  const [activeAccount] = await user`
    SELECT status, transaction FROM accounts WHERE "userAddress" = ${wallet}
  `;
  assert.equal(activeAccount.status, 'active');
  assert.ok(activeAccount.transaction);
});

test('social providers (google, discord, github, x) deterministically map to zero-balance 0u Universal Accounts', async () => {
  const providers = ['google', 'discord', 'github', 'x'] as const;
  const seen = new Set<string>();
  for (const provider of providers) {
    const key = derive(`${provider}:user-12345`);
    const first = await prepare(key);
    const second = await prepare(derive(`${provider}:user-12345`));
    assert.equal(first.account, second.account);
    assert.match(first.account, /^0u[0123456789abcdefghjkmnpqrstvwxyz]{52}$/);
    assert.ok(Buffer.from(first.state, 'base64').length <= 770);
    seen.add(first.account);
  }
  assert.equal(seen.size, providers.length);
});

test('POST /api/auth/link attaches EVM and Solana wallets with zero signatures, rejects invalid addresses (400), unauthenticated calls (401), and cross-user conflicts (409)', async () => {
  const identityA = `passkey:cred-a-${randomUUID()}`;
  const ownerCompressedA = derive(identityA);
  const preparedA = await prepare(ownerCompressedA, 'mainnet');
  const walletA = preparedA.account;
  createdWallets.add(walletA);
  registerExpectedWalletOnMock(walletA, ownerCompressedA);

  await user`INSERT INTO users("userAddress", name) VALUES (${walletA}, 'User A')`;
  await user`
    INSERT INTO accounts("userAddress", network, state, code, status)
    VALUES (${walletA}, 'mainnet', ${preparedA.state}, ${preparedA.code}, 'active')
  `;
  await user`
    INSERT INTO identities(id, "userAddress", provider)
    VALUES (${identityA}, ${walletA}, 'passkey')
  `;
  const tokenA = await signJwt(
    privateKey,
    issuer!,
    walletA,
    randomBytes(32).toString('base64url'),
    3600,
  );
  await user`
    INSERT INTO tokens(id, "userAddress", jwt, expires)
    VALUES (${digest(tokenA)}, ${walletA}, 'enc-a', now() + interval '1 hour')
  `;

  const identityB = `email:userb-${randomUUID()}@man0.space`;
  const ownerCompressedB = derive(identityB);
  const preparedB = await prepare(ownerCompressedB, 'mainnet');
  const walletB = preparedB.account;
  createdWallets.add(walletB);
  registerExpectedWalletOnMock(walletB, ownerCompressedB);

  await user`INSERT INTO users("userAddress", name) VALUES (${walletB}, 'User B')`;
  await user`
    INSERT INTO accounts("userAddress", network, state, code, status)
    VALUES (${walletB}, 'mainnet', ${preparedB.state}, ${preparedB.code}, 'active')
  `;
  await user`
    INSERT INTO identities(id, "userAddress", provider)
    VALUES (${identityB}, ${walletB}, 'email')
  `;
  const tokenB = await signJwt(
    privateKey,
    issuer!,
    walletB,
    randomBytes(32).toString('base64url'),
    3600,
  );
  await user`
    INSERT INTO tokens(id, "userAddress", jwt, expires)
    VALUES (${digest(tokenB)}, ${walletB}, 'enc-b', now() + interval '1 hour')
  `;

  const evmPriv = secp256k1.utils.randomSecretKey();
  const evmPub64 = secp256k1.getPublicKey(evmPriv, false).subarray(1, 65);
  const evmAddress = `0x${keccak256(evmPub64).subarray(12, 32).toString('hex')}`;

  const svmPriv = ed25519.utils.randomSecretKey();
  const svmPub = ed25519.getPublicKey(svmPriv);
  const svmAddress = base58.encode(svmPub);

  // 1. Unauthenticated rejection
  const unauthRes = await app.inject({
    method: 'POST',
    url: '/api/auth/link',
    payload: { network: 'evm', address: evmAddress },
  });
  assert.equal(unauthRes.statusCode, 401);

  // 2. Invalid address rejection
  const invalidEvmRes = await app.inject({
    method: 'POST',
    url: '/api/auth/link',
    headers: { authorization: `Bearer ${tokenA}` },
    payload: { network: 'evm', address: '0xnotanaddress' },
  });
  assert.equal(invalidEvmRes.statusCode, 400);

  // 3. Zero-signature EVM attachment on User A (with EIP-6963 provider metadata)
  const attachEvmRes = await app.inject({
    method: 'POST',
    url: '/api/auth/link',
    headers: { authorization: `Bearer ${tokenA}` },
    payload: {
      network: 'evm',
      address: evmAddress.toUpperCase().replace(/^0X/, '0x'),
      providerRdns: 'io.metamask',
      providerName: 'MetaMask',
    },
  });
  assert.equal(attachEvmRes.statusCode, 200);
  const attachedEvm = attachEvmRes.json() as {
    id: string;
    status: string;
    address: string;
    network: string;
    providerRdns?: string;
    providerName?: string;
  };
  assert.ok(attachedEvm.id);
  assert.equal(attachedEvm.status, 'active');
  assert.equal(attachedEvm.network, 'evm');
  assert.equal(attachedEvm.address, evmAddress.toLowerCase());
  assert.equal(attachedEvm.providerRdns, 'io.metamask');
  assert.equal(attachedEvm.providerName, 'MetaMask');

  const listARes = await app.inject({
    method: 'GET',
    url: '/api/auth/links',
    headers: { authorization: `Bearer ${tokenA}` },
  });
  assert.equal(listARes.statusCode, 200);
  const linksA = listARes.json() as Array<{
    id: string;
    address: string;
    providerRdns?: string;
    providerName?: string;
  }>;
  assert.equal(linksA.length, 1);
  assert.equal(linksA[0]!.providerRdns, 'io.metamask');
  assert.equal(linksA[0]!.providerName, 'MetaMask');

  // 4. Cross-account conflict rejection (User B tries to attach User A's EVM wallet)
  const conflictRes = await app.inject({
    method: 'POST',
    url: '/api/auth/link',
    headers: { authorization: `Bearer ${tokenB}` },
    payload: { network: 'evm', address: evmAddress },
  });
  assert.equal(conflictRes.statusCode, 409);

  // 5. Cross-account unlink rejection (User B cannot unlink User A's EVM wallet)
  const forbiddenUnlinkRes = await app.inject({
    method: 'DELETE',
    url: `/api/auth/link/${encodeURIComponent(attachedEvm.id)}`,
    headers: { authorization: `Bearer ${tokenB}` },
  });
  assert.equal(forbiddenUnlinkRes.statusCode, 403);

  // 6. Owner unlink succeeds (200), freeing the EVM wallet so User B can attach it
  const unlinkARes = await app.inject({
    method: 'DELETE',
    url: `/api/auth/link/${encodeURIComponent(attachedEvm.id)}`,
    headers: { authorization: `Bearer ${tokenA}` },
  });
  assert.equal(unlinkARes.statusCode, 200);
  assert.deepEqual(unlinkARes.json(), { removed: true, id: attachedEvm.id });

  const missingUnlinkRes = await app.inject({
    method: 'DELETE',
    url: `/api/auth/link/${encodeURIComponent(attachedEvm.id)}`,
    headers: { authorization: `Bearer ${tokenA}` },
  });
  assert.equal(missingUnlinkRes.statusCode, 404);

  const reattachToBRes = await app.inject({
    method: 'POST',
    url: '/api/auth/link',
    headers: { authorization: `Bearer ${tokenB}` },
    payload: {
      network: 'evm',
      address: evmAddress,
      providerRdns: 'io.rabby',
      providerName: 'Rabby',
    },
  });
  assert.equal(reattachToBRes.statusCode, 200);
  assert.equal(reattachToBRes.json().providerRdns, 'io.rabby');

  // 7. Zero-signature Solana attachment on User B + GET /api/auth/links
  const attachSvmRes = await app.inject({
    method: 'POST',
    url: '/api/auth/link',
    headers: { authorization: `Bearer ${tokenB}` },
    payload: { network: 'svm', address: svmAddress, providerName: 'Phantom' },
  });
  assert.equal(attachSvmRes.statusCode, 200);
  assert.equal(attachSvmRes.json().status, 'active');
  assert.equal(attachSvmRes.json().address, svmAddress);
  assert.equal(attachSvmRes.json().providerName, 'Phantom');

  const listB = await app.inject({
    method: 'GET',
    url: '/api/auth/links',
    headers: { authorization: `Bearer ${tokenB}` },
  });
  assert.equal(listB.statusCode, 200);
  const linksB = listB.json() as Array<{
    network: string;
    address: string;
    status: string;
    providerRdns?: string;
    providerName?: string;
  }>;
  assert.equal(linksB.length, 2);
  const svmLinkB = linksB.find(l => l.network === 'svm');
  assert.ok(svmLinkB);
  assert.equal(svmLinkB.address, svmAddress);
  assert.equal(svmLinkB.status, 'active');
  assert.equal(svmLinkB.providerName, 'Phantom');
});

test('0u Universal Account aggregates NEP-141 + intents.near USDC balances, auto-withdraws via ft_withdraw on spending approve, and executes on-chain mt_transfer for intents deposits', async t => {
  t.mock.method(
    OneClickService,
    'submitDepositTx',
    async (req: { txHash: string; depositAddress: string }) => {
      mockChain.depositSubmittedTxs.push({
        txHash: req.txHash,
        depositAddress: req.depositAddress,
      });
      return {} as never;
    },
  );
  const activeNet = config.network;
  const settlementUsdc = usdcFor(activeNet);
  const identityC = `email:intents-user-${randomUUID()}@man0.space`;
  const ownerCompressedC = derive(identityC);
  const preparedC = await prepare(ownerCompressedC, activeNet);
  const walletC = preparedC.account;
  createdWallets.add(walletC);
  registerExpectedWalletOnMock(walletC, ownerCompressedC, codeFor(activeNet));

  await user`INSERT INTO users("userAddress", name) VALUES (${walletC}, 'User C')`;
  await user`
    INSERT INTO accounts("userAddress", network, state, code, status)
    VALUES (${walletC}, ${activeNet}, ${preparedC.state}, ${preparedC.code}, 'active')
  `;
  await user`
    INSERT INTO identities(id, "userAddress", provider)
    VALUES (${identityC}, ${walletC}, 'email')
  `;
  await acceptConsent(
    { policy: policyHash, terms: true, privacy: true },
    walletC,
    'test-token',
  );
  const tokenC = await signJwt(
    privateKey,
    issuer!,
    walletC,
    randomBytes(32).toString('base64url'),
    3600,
  );
  await user`
    INSERT INTO tokens(id, "userAddress", jwt, expires)
    VALUES (${digest(tokenC)}, ${walletC}, 'enc-c', now() + interval '1 hour')
  `;

  // Seed $1.50 in NEP-141 USDC + $3.50 in NEAR Intents multi-token USDC = $5.00 total
  mockChain.ftBalances.set(`${settlementUsdc}:${walletC}`, '1500000');
  mockChain.mtBalances.set(`${walletC}:nep141:${settlementUsdc}`, '3500000');

  const balRes = await app.inject({
    method: 'GET',
    url: '/api/near/balance',
    headers: { authorization: `Bearer ${tokenC}` },
  });
  assert.equal(balRes.statusCode, 200);
  const balBody = balRes.json() as {
    mainBalanceWei: string;
    spendingBalanceWei: string;
    spendingAddress: string;
  };
  assert.equal(balBody.mainBalanceWei, '5000000');
  assert.equal(balBody.spendingBalanceWei, '0');

  // Approve $4.00 spending limit -> requires $1.50 from NEP-141 + $2.50 via ft_withdraw from intents verifier
  mockChain.broadcastCalls.length = 0;
  const approveRes = await app.inject({
    method: 'POST',
    url: '/api/near/spending/approve',
    headers: { authorization: `Bearer ${tokenC}` },
    payload: { amountWei: '4000000' },
  });
  assert.equal(approveRes.statusCode, 200);
  const approveBody = approveRes.json() as {
    mainBalanceWei: string;
    spendingBalanceWei: string;
    txHash: string | null;
  };
  assert.ok(approveBody.txHash);
  assert.ok(
    mockChain.broadcastCalls.some(c => c.txText.includes('ft_withdraw')),
    'Expected approveSpendingLimit to execute ft_withdraw from NEAR Intents verifier',
  );

  // Execute gasless/intents leg via on-chain mt_transfer on NEAR Intents verifier
  mockChain.broadcastCalls.length = 0;
  mockChain.depositSubmittedTxs.length = 0;
  const genRes = await app.inject({
    method: 'POST',
    url: '/api/near/intents/generate',
    headers: { authorization: `Bearer ${tokenC}` },
    payload: {
      depositAddress: 'deposit-target.near',
      assetId: `nep141:${settlementUsdc}`,
      amountAtomic: '1000000',
    },
  });
  assert.equal(genRes.statusCode, 200);
  const genBody = genRes.json() as { submittedOnChain?: boolean; txHash?: string };
  assert.equal(genBody.submittedOnChain, true);
  assert.ok(genBody.txHash);
  assert.ok(
    mockChain.broadcastCalls.some(c => c.txText.includes('mt_transfer')),
    'Expected /api/near/intents/generate to execute mt_transfer on NEAR Intents verifier',
  );
  assert.equal(mockChain.depositSubmittedTxs.length, 1);
  assert.equal(mockChain.depositSubmittedTxs[0]?.depositAddress, 'deposit-target.near');
});
