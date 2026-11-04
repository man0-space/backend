import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  commitment,
  address,
  initialization,
  state,
  extractStateKey,
  intentsPublicKey,
  uncompress,
  compress,
} from '../auth/protocol.js';
import {
  codeFor,
  MAINNET_GLOBAL_WALLET_CONTRACT,
  prepareSpending,
  TESTNET_GLOBAL_WALLET_CODE_HASH,
} from '../auth/account.js';
import { rpcFor } from '../config.js';
import { base58 } from '@scure/base';
import { p256 } from '@noble/curves/nist.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';

test('native wallet canonical message matches the upstream empty-request fixture', () => {
  assert.equal(
    commitment({
      network_id: 'mainnet',
      signer_id: '0s0000000000000000000000000000000000000000',
      nonce: 0,
      created_at: '1970-01-01T00:00:00Z',
      timeout_secs: 3600,
      request: {},
    }).toString('hex'),
    'a8df85c0e8793716904fd57e9bef7d83b12773508bd3c9fca554afbfb108d4b5',
  );
});

test('native MPC function-call commitment matches the upstream signed-request fixture', () => {
  const args = Buffer.from(
    JSON.stringify({ request: { payload_v2: { Ecdsa: '0'.repeat(64) }, domain_id: 0, path: '' } }),
  ).toString('base64');
  assert.equal(
    commitment({
      network_id: 'mainnet',
      signer_id: '0se5eba21e8f191e1880e453794bc551dfa50a3419',
      nonce: 2845491008,
      created_at: '2026-07-07T11:13:29Z',
      timeout_secs: 3600,
      request: {
        external: [
          {
            receiver_id: 'v1.signer',
            actions: [
              { action: 'function_call', payload: { function_name: 'sign', args, deposit: '1' } },
            ],
          },
        ],
      },
    }).toString('hex'),
    '7c8560b51380551676a54dac49dcc1e009af3020556cde8e1e2172782ffd6775',
  );
});

test('universal accounts commit to the exact wallet code, key and extension set', () => {
  const code = base58.encode(Buffer.alloc(32, 1));
  const key = Buffer.concat([Buffer.from([2]), Buffer.alloc(32, 3)]);
  const raw = initialization(code, state(key));
  const id = address(raw);
  assert.match(id, /^0u[0123456789abcdefghjkmnpqrstvwxyz]{51}[0g]$/);
  assert.equal(
    address(initialization(code, state(key, 0, 3600, ['b.near', 'a.near']))),
    address(initialization(code, state(key, 0, 3600, ['a.near', 'b.near', 'a.near']))),
  );
  assert.notEqual(address(initialization(code, state(key, 1))), id);
  assert.notEqual(address(initialization(code, state(key, 0, 3600, ['extension.near']))), id);
  assert.notEqual(address(Buffer.concat([raw, Buffer.from([0])])), id);
  assert.throws(() => state(Buffer.alloc(33)), /P-256/);
  assert.throws(() => compress(Buffer.alloc(32, 7)), /P-256/);
});

test('mainnet AccountId and testnet CodeHash UniversalStateInit encodings preserve outer V1 and Some(code) bytes and select matching RPC', () => {
  const priv = p256.utils.randomSecretKey();
  const compressed = p256.getPublicKey(priv, true);
  const rawState = state(compressed);

  const mainnetCode = codeFor('mainnet');
  const testnetCode = codeFor('testnet');
  assert.equal(mainnetCode, MAINNET_GLOBAL_WALLET_CONTRACT);
  assert.equal(testnetCode, TESTNET_GLOBAL_WALLET_CODE_HASH);

  const mainnetInit = initialization(mainnetCode, rawState);
  const testnetInit = initialization(testnetCode, rawState);

  // Outer UniversalStateInit::V1 (0x00) and Option::Some(code) (0x01)
  assert.equal(mainnetInit[0], 0);
  assert.equal(mainnetInit[1], 1);
  // GlobalContractIdentifier::AccountId discriminant = 1
  assert.equal(mainnetInit[2], 1);
  assert.equal(mainnetInit.readUInt32LE(3), Buffer.byteLength(mainnetCode, 'utf8'));
  assert.equal(
    mainnetInit.subarray(7, 7 + mainnetCode.length).toString('utf8'),
    mainnetCode,
  );

  assert.equal(testnetInit[0], 0);
  assert.equal(testnetInit[1], 1);
  // GlobalContractIdentifier::CodeHash discriminant = 0
  assert.equal(testnetInit[2], 0);
  assert.deepEqual(
    testnetInit.subarray(3, 35),
    Buffer.from(base58.decode(testnetCode)),
  );

  // Both encodings allow round-trip extraction of the 33-byte compressed P-256 owner key
  assert.deepEqual(extractStateKey(mainnetInit), Buffer.from(compressed));
  assert.deepEqual(extractStateKey(testnetInit), Buffer.from(compressed));

  // Mainnet and testnet produce distinct 0u addresses for the same owner key
  assert.notEqual(address(mainnetInit), address(testnetInit));

  // RPC selection matches network
  assert.ok(rpcFor('mainnet').includes('fastnear') || rpcFor('mainnet').includes('mainnet'));
  assert.ok(rpcFor('testnet').includes('testnet'));
  assert.notEqual(rpcFor('mainnet'), rpcFor('testnet'));
});

test('intentsPublicKey converts compressed 33-byte P-256 and secp256k1 keys into raw 64-byte x||y coordinates without 0x04 prefix', () => {
  const p256Priv = p256.utils.randomSecretKey();
  const p256Compressed = p256.getPublicKey(p256Priv, true);
  const p256Uncompressed65 = p256.getPublicKey(p256Priv, false);
  const raw64 = uncompress(p256Compressed);
  assert.equal(raw64.length, 64);
  assert.deepEqual(raw64, Buffer.from(p256Uncompressed65.subarray(1, 65)));

  const intentsP256 = intentsPublicKey('p256', p256Compressed);
  assert.ok(intentsP256.startsWith('p256:'));
  assert.equal(base58.decode(intentsP256.slice(5)).length, 64);

  const secpPriv = secp256k1.utils.randomSecretKey();
  const secpCompressed = secp256k1.getPublicKey(secpPriv, true);
  const intentsSecp = intentsPublicKey('secp256k1', secpCompressed);
  assert.ok(intentsSecp.startsWith('secp256k1:'));
  assert.equal(base58.decode(intentsSecp.slice(10)).length, 64);

  const spending = prepareSpending(p256Compressed, 'mainnet');
  assert.match(spending.account, /^0u[0123456789abcdefghjkmnpqrstvwxyz]{51}[0g]$/);
  assert.notEqual(spending.account, address(initialization(codeFor('mainnet'), state(p256Compressed))));
  assert.deepEqual(
    extractStateKey(Buffer.from(spending.state, 'base64')),
    Buffer.from(p256Compressed),
  );
});
