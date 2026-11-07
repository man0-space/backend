import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createHash, randomBytes, randomUUID } from 'node:crypto';
import { isoCBOR } from '@simplewebauthn/server/helpers';
import { base58 } from '@scure/base';
import { p256 } from '@noble/curves/nist.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { ed25519 } from '@noble/curves/ed25519.js';
import { ready, composer } from '../databases/cache.js';
import { user, workflow } from '../databases/client.js';
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
  failBroadcastCount: number;
  skipHasPublicKeyCount: number;
}

const mockChain: MockChainState = {
  initializedAccounts: new Map(),
  intentsKeys: new Map(),
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
    if (
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

          if (accountId === 'intents.near' && methodName === 'has_public_key') {
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

          if (accountId === 'intents.near' && methodName === 'public_keys_of') {
            const targetAcct = String(argsJson.account_id || '');
            const keys = Array.from(mockChain.intentsKeys.get(targetAcct) ?? []);
            const resultBytes = Array.from(Buffer.from(JSON.stringify(keys), 'utf8'));
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

  // 3. Zero-signature EVM attachment on User A
  const attachEvmRes = await app.inject({
    method: 'POST',
    url: '/api/auth/link',
    headers: { authorization: `Bearer ${tokenA}` },
    payload: { network: 'evm', address: evmAddress.toUpperCase().replace(/^0X/, '0x') },
  });
  assert.equal(attachEvmRes.statusCode, 200);
  const attachedEvm = attachEvmRes.json() as { status: string; address: string; network: string };
  assert.equal(attachedEvm.status, 'active');
  assert.equal(attachedEvm.network, 'evm');
  assert.equal(attachedEvm.address, evmAddress.toLowerCase());

  // 4. Cross-account conflict rejection (User B tries to attach User A's EVM wallet)
  const conflictRes = await app.inject({
    method: 'POST',
    url: '/api/auth/link',
    headers: { authorization: `Bearer ${tokenB}` },
    payload: { network: 'evm', address: evmAddress },
  });
  assert.equal(conflictRes.statusCode, 409);

  // 5. Zero-signature Solana attachment on User B + GET /api/auth/links
  const attachSvmRes = await app.inject({
    method: 'POST',
    url: '/api/auth/link',
    headers: { authorization: `Bearer ${tokenB}` },
    payload: { network: 'svm', address: svmAddress },
  });
  assert.equal(attachSvmRes.statusCode, 200);
  assert.equal(attachSvmRes.json().status, 'active');
  assert.equal(attachSvmRes.json().address, svmAddress);

  const listB = await app.inject({
    method: 'GET',
    url: '/api/auth/links',
    headers: { authorization: `Bearer ${tokenB}` },
  });
  assert.equal(listB.statusCode, 200);
  const linksB = listB.json() as Array<{ network: string; address: string; status: string }>;
  assert.equal(linksB.length, 1);
  assert.equal(linksB[0]!.network, 'svm');
  assert.equal(linksB[0]!.address, svmAddress);
  assert.equal(linksB[0]!.status, 'active');
});
