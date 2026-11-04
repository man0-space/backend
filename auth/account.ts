import { createECDH, createHash, hkdfSync, randomBytes, randomInt } from 'node:crypto';
import { createRequire } from 'node:module';
import { base58 } from '@scure/base';
import { ed25519 } from '@noble/curves/ed25519.js';
import { config, required, rpcFor, treasuryFor, usdcFor } from '../config.js';
import { cached, cacheDel } from '../databases/cache.js';
import { user } from '../databases/client.js';
import {
  addFullAccessKeyAction,
  address,
  buildWalletAddPublicKeyMessage,
  buildWalletContractCallMessage,
  commitment,
  compress,
  ed25519AccessKeyHandle,
  extractStateKey,
  functionCallAction,
  initialization,
  intentsPublicKey,
  serializeTransaction,
  signWebAuthnP256,
  state,
  transferAction,
  universalStateInitAction,
  type Message,
  type WebAuthnProof,
} from './protocol.js';

const require = createRequire(import.meta.url);

export const MAINNET_GLOBAL_WALLET_CONTRACT =
  process.env.NEAR_UNIVERSAL_CONTRACT_ACCOUNT?.trim() ||
  '0saf343be226341c0eca7dba6d0b29d49bdff3ad03';

export const TESTNET_GLOBAL_WALLET_CODE_HASH =
  process.env.NEAR_UNIVERSAL_CONTRACT_CODE_HASH?.trim() ||
  'AjYXfrYzBs5BR7GmmFgCSghc6nccq4LCfSxkYTUqnZKK';

export function codeFor(network: 'mainnet' | 'testnet' = config.network): string {
  return network === 'mainnet'
    ? MAINNET_GLOBAL_WALLET_CONTRACT
    : TESTNET_GLOBAL_WALLET_CODE_HASH;
}

export const code = codeFor(config.network);

export interface Account {
  account: string;
  state: string;
  code: string;
}

export function derivePrivate(id: string): Buffer {
  return Buffer.from(
    hkdfSync(
      'sha256',
      Buffer.from(config.secret, 'hex'),
      Buffer.from(id, 'utf8'),
      Buffer.from('universal account owner', 'utf8'),
      32,
    ),
  );
}

export function derive(id: string): Buffer {
  const seed = derivePrivate(id);
  const ecdh = createECDH('prime256v1');
  ecdh.setPrivateKey(seed);
  return Buffer.from(ecdh.getPublicKey(null, 'compressed'));
}

export async function prepare(
  key: Uint8Array,
  network: 'mainnet' | 'testnet' = config.network,
): Promise<Account> {
  const targetCode = codeFor(network);
  const compressed = compress(key);
  const rawState = state(compressed);
  const rawInit = initialization(targetCode, rawState);
  const account = address(rawInit);
  return {
    account,
    state: rawInit.toString('base64'),
    code: targetCode,
  };
}

export function facilitatorPublicKey32(): Buffer {
  const raw = config.facilitatorPrivateKey.trim();
  const stripped = raw.startsWith('ed25519:') ? raw.slice(8) : raw;
  const decoded = Buffer.from(base58.decode(stripped));
  if (decoded.length >= 64) {
    return Buffer.from(decoded.subarray(32, 64));
  }
  if (decoded.length === 32) {
    return Buffer.from(ed25519.getPublicKey(decoded));
  }
  throw new Error('Invalid NEAR_FACILITATOR_KEY length.');
}

export function prepareSpending(
  key: Uint8Array,
  network: 'mainnet' | 'testnet' = config.network,
): Account {
  const targetCode = codeFor(network);
  const compressed = compress(key);
  const rawState = state(compressed, 1);
  const rawInit = initialization(targetCode, rawState, [
    ed25519AccessKeyHandle(facilitatorPublicKey32()),
  ]);
  return {
    account: address(rawInit),
    state: rawInit.toString('base64'),
    code: targetCode,
  };
}
